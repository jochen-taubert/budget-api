// Minimaler In-Memory-Ersatz für den DynamoDBDocumentClient.
// Er bildet nur die Semantik der Befehle nach, die das Repository tatsächlich nutzt,
// damit sich Fehlerpfade (Überziehen, Idempotenz, fehlendes Budget) ohne AWS testen lassen.
// Die echten Expressions prüft erst ein Deployment (siehe scripts/smoke.sh).

import type {
  GetCommandInput,
  QueryCommandInput,
  TransactWriteCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../src/repository.ts';

type Item = Record<string, any>;
type Update = NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']>;
type Put = NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Put']>;

export interface SentCommand {
  name: string;
  input: any;
}

const conditionFailed = () =>
  Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

export function createFakeDynamo({ pageSize = 2 } = {}) {
  const table = new Map<string, Item>();
  const key = (k: Item) => `${k.pk}|${k.sk}`;
  const sent: SentCommand[] = [];

  const checkPut = (put: Put) => !table.has(key(put.Item!));
  const checkBudgetUpdate = (upd: Update) => {
    const item = table.get(key(upd.Key!));
    return item !== undefined && item.remainingCents >= upd.ExpressionAttributeValues![':amt'];
  };
  const applyBudgetUpdate = (upd: Update) => {
    const item = table.get(key(upd.Key!))!;
    const amt: number = upd.ExpressionAttributeValues![':amt'];
    table.set(key(upd.Key!), {
      ...item,
      remainingCents: item.remainingCents - amt,
      spentCents: item.spentCents + amt,
      updatedAt: upd.ExpressionAttributeValues![':now'],
    });
  };

  const handlers: Record<string, (input: any) => unknown> = {
    GetCommand: (input: GetCommandInput) => ({ Item: structuredClone(table.get(key(input.Key!))) }),

    QueryCommand: (input: QueryCommandInput) => {
      const pk = input.ExpressionAttributeValues![':pk'];
      const prefix: string = input.ExpressionAttributeValues![':prefix'];
      const all = [...table.values()]
        .filter((i) => i.pk === pk && i.sk.startsWith(prefix))
        .sort((a, b) => a.sk.localeCompare(b.sk));
      const start = input.ExclusiveStartKey ? all.findIndex((i) => i.sk === input.ExclusiveStartKey!.sk) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return { Items: structuredClone(page), LastEvaluatedKey: more ? { pk, sk: page.at(-1)!.sk } : undefined };
    },

    // Nur der Budget-Upsert aus setBudget.
    UpdateCommand: (input: UpdateCommandInput) => {
      const v = input.ExpressionAttributeValues!;
      const existing = table.get(key(input.Key!));
      if (existing && existing.spentCents > v[':limit']) throw conditionFailed();
      const spent: number = existing?.spentCents ?? 0;
      const item: Item = {
        ...existing,
        ...input.Key,
        month: v[':month'],
        limitCents: v[':limit'],
        currency: v[':eur'],
        updatedAt: v[':now'],
        spentCents: spent,
        remainingCents: v[':limit'] - spent,
      };
      table.set(key(input.Key!), item);
      return { Attributes: structuredClone(item) };
    },

    TransactWriteCommand: (input: TransactWriteCommandInput) => {
      const tx = input.TransactItems!;
      const results = tx.map((ti) => (ti.Put ? checkPut(ti.Put) : checkBudgetUpdate(ti.Update!)));
      if (results.includes(false)) {
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: results.map((ok) => ({ Code: ok ? 'None' : 'ConditionalCheckFailed' })),
        });
      }
      for (const ti of tx) {
        if (ti.Put) table.set(key(ti.Put.Item!), structuredClone(ti.Put.Item!));
        else applyBudgetUpdate(ti.Update!);
      }
      return {};
    },
  };

  const fake = {
    table,
    sent,
    async send(command: { input: unknown }) {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const handler = handlers[name];
      if (!handler) throw new Error(`FakeDynamo: ${name} nicht unterstützt`);
      return handler(command.input);
    },
  };
  return fake as typeof fake & DocClient;
}
