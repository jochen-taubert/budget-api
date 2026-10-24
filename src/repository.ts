import { createHash, randomUUID } from 'node:crypto';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  budgetNotFound,
  idempotencyConflict,
  insufficientBudget,
  limitBelowSpent,
  type Budget,
  type BudgetRepository,
  type Expense,
  type ExpenseInput,
  type Month,
} from './domain.ts';

// Single-Table-Design, ein Partition Key pro Mitarbeiter:in eines Mandanten.
//
//   pk = T#<tenant>#E#<employee>
//   sk = BUDGET#2026-10                          Monatsbudget (Limit, verbraucht, verbleibend)
//   sk = TX#2026-10#<createdAt>#<id>              einzelne Buchung, chronologisch sortiert
//   sk = IDEMP#<key>                              Idempotenz-Eintrag, läuft per TTL aus
//
// Alles, was für eine Monatsansicht nötig ist, liegt so in einer Partition und ist
// mit einem Get und einem Query lesbar.

/** Nur die eine Methode, die wir brauchen – erleichtert Tests mit einem Fake. */
export type DocClient = Pick<DynamoDBDocumentClient, 'send'>;

interface Keys {
  pk: string;
  sk: string;
}
type BudgetItem = Keys & Budget;
type ExpenseItem = Keys & Expense & { type: 'EXPENSE' };
interface IdempotencyItem extends Keys {
  txSk: string;
  fingerprint: string;
  ttl: number;
}

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 3600;

const pkOf = (tenant: string, employee: string) => `T#${tenant}#E#${employee}`;
const budgetSk = (month: Month) => `BUDGET#${month}`;

const toBudget = (item: BudgetItem): Budget => ({
  month: item.month,
  limitCents: item.limitCents,
  spentCents: item.spentCents,
  remainingCents: item.remainingCents,
  currency: item.currency,
  updatedAt: item.updatedAt,
});

const toExpense = (item: ExpenseItem): Expense => ({
  id: item.id,
  month: item.month,
  amountCents: item.amountCents,
  category: item.category,
  description: item.description,
  createdAt: item.createdAt,
});

const fingerprint = (input: ExpenseInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.month, input.amountCents, input.category, input.description]))
    .digest('hex');

interface CancellationError {
  name: 'TransactionCanceledException';
  CancellationReasons?: { Code?: string }[];
}
const isTransactionCanceled = (err: unknown): err is CancellationError =>
  err instanceof Error && err.name === 'TransactionCanceledException';
const isConditionFailed = (err: unknown) => err instanceof Error && err.name === 'ConditionalCheckFailedException';

export interface RepositoryOptions {
  db: DocClient;
  tableName: string;
  now?: () => Date;
  newId?: () => string;
}

export function createRepository({
  db,
  tableName,
  now = () => new Date(),
  newId = randomUUID,
}: RepositoryOptions): BudgetRepository {
  async function getItem<T>(pk: string, sk: string): Promise<T | undefined> {
    const res = await db.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }));
    return res.Item as T | undefined;
  }

  return {
    async setBudget(tenant, employee, month, { limitCents }) {
      try {
        const res = await db.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: pkOf(tenant, employee), sk: budgetSk(month) },
            // remainingCents wird beim Anlegen und bei jeder Limitänderung aus dem
            // bereits Verbrauchten neu berechnet.
            UpdateExpression:
              'SET #month = :month, limitCents = :limit, currency = :eur, updatedAt = :now, ' +
              'spentCents = if_not_exists(spentCents, :zero), ' +
              'remainingCents = :limit - if_not_exists(spentCents, :zero)',
            ConditionExpression: 'attribute_not_exists(pk) OR spentCents <= :limit',
            ExpressionAttributeNames: { '#month': 'month' },
            ExpressionAttributeValues: {
              ':month': month,
              ':limit': limitCents,
              ':eur': 'EUR',
              ':now': now().toISOString(),
              ':zero': 0,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return toBudget(res.Attributes as BudgetItem);
      } catch (err) {
        if (isConditionFailed(err)) throw limitBelowSpent();
        throw err;
      }
    },

    async getMonth(tenant, employee, month) {
      const pk = pkOf(tenant, employee);
      const budget = await getItem<BudgetItem>(pk, budgetSk(month));
      if (!budget) throw budgetNotFound(month);

      const expenses: Expense[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const res = await db.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': pk, ':prefix': `TX#${month}#` },
            ExclusiveStartKey,
          }),
        );
        expenses.push(...((res.Items ?? []) as ExpenseItem[]).map(toExpense));
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);

      return { ...toBudget(budget), expenses };
    },

    async bookExpense(tenant, employee, input, idempotencyKey) {
      const pk = pkOf(tenant, employee);
      const id = newId();
      const createdAt = now().toISOString();
      const txSk = `TX#${input.month}#${createdAt}#${id}`;
      const item: ExpenseItem = { pk, sk: txSk, type: 'EXPENSE', id, createdAt, ...input };

      // Alles oder nichts: Budget abbuchen, Buchung schreiben, Idempotenz-Key belegen.
      // Die Bedingung remainingCents >= :amt verhindert Überziehen auch dann,
      // wenn zwei Buchungen gleichzeitig eintreffen. DynamoDB kann in Bedingungen
      // nicht rechnen, deshalb wird remainingCents als eigenes Feld geführt.
      const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        {
          Update: {
            TableName: tableName,
            Key: { pk, sk: budgetSk(input.month) },
            UpdateExpression:
              'SET remainingCents = remainingCents - :amt, spentCents = spentCents + :amt, updatedAt = :now',
            ConditionExpression: 'attribute_exists(pk) AND remainingCents >= :amt',
            ExpressionAttributeValues: { ':amt': input.amountCents, ':now': createdAt },
          },
        },
        {
          Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(pk)' },
        },
      ];

      if (idempotencyKey) {
        const marker: IdempotencyItem = {
          pk,
          sk: `IDEMP#${idempotencyKey}`,
          txSk,
          fingerprint: fingerprint(input),
          ttl: Math.floor(now().getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
        };
        items.push({ Put: { TableName: tableName, Item: marker, ConditionExpression: 'attribute_not_exists(pk)' } });
      }

      try {
        await db.send(new TransactWriteCommand({ TransactItems: items }));
        return { expense: toExpense(item), replayed: false };
      } catch (err) {
        if (!isTransactionCanceled(err)) throw err;
        const failed = (i: number) => err.CancellationReasons?.[i]?.Code === 'ConditionalCheckFailed';

        // Wiederholter Request: Original zurückgeben statt doppelt zu buchen.
        if (idempotencyKey && failed(2)) {
          const marker = await getItem<IdempotencyItem>(pk, `IDEMP#${idempotencyKey}`);
          if (!marker) throw new Error('Idempotenz-Eintrag nicht gefunden', { cause: err });
          if (marker.fingerprint !== fingerprint(input)) throw idempotencyConflict();
          const original = await getItem<ExpenseItem>(pk, marker.txSk);
          if (!original) throw new Error('Originalbuchung nicht gefunden', { cause: err });
          return { expense: toExpense(original), replayed: true };
        }
        if (failed(0)) {
          const budget = await getItem<BudgetItem>(pk, budgetSk(input.month));
          if (!budget) throw budgetNotFound(input.month);
          throw insufficientBudget(budget.remainingCents);
        }
        throw err;
      }
    },
  };
}
