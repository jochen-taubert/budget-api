// Fachliche Typen, Regeln und Validierung – bewusst frei von AWS-Abhängigkeiten.

export const CATEGORIES = ['OEPNV', 'BAHN', 'FAHRRAD', 'CARSHARING', 'SCOOTER'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Monat im Format YYYY-MM */
export type Month = string;

export interface Budget {
  month: Month;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  currency: 'EUR';
  updatedAt: string;
}

export interface ExpenseInput {
  month: Month;
  amountCents: number;
  category: Category;
  description: string;
}

export interface DocumentReference {
  documentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface Expense extends ExpenseInput {
  id: string;
  createdAt: string;
  documents?: DocumentReference[];
}

export interface MonthView extends Budget {
  expenses: Expense[];
}

export interface BudgetInput {
  limitCents: number;
}

/** Fachliche Schnittstelle zum Speicher – die HTTP-Schicht kennt nur diesen Vertrag. */
export interface BudgetRepository {
  setBudget(tenant: string, employee: string, month: Month, input: BudgetInput): Promise<Budget>;
  getMonth(tenant: string, employee: string, month: Month): Promise<MonthView>;
  bookExpense(
    tenant: string,
    employee: string,
    input: ExpenseInput,
    idempotencyKey?: string,
  ): Promise<{ expense: Expense; replayed: boolean }>;
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN'
  | 'BUDGET_NOT_FOUND'
  | 'INSUFFICIENT_BUDGET'
  | 'LIMIT_BELOW_SPENT'
  | 'IDEMPOTENCY_CONFLICT';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationError = (message: string) => new DomainError('VALIDATION_ERROR', message, 400);
export const forbidden = (message: string) => new DomainError('FORBIDDEN', message, 403);
export const budgetNotFound = (month: Month) =>
  new DomainError('BUDGET_NOT_FOUND', `Für ${month} ist kein Budget angelegt`, 404);
export const insufficientBudget = (remainingCents: number) =>
  new DomainError('INSUFFICIENT_BUDGET', 'Das Budget reicht für diese Buchung nicht aus', 409, { remainingCents });
export const limitBelowSpent = () =>
  new DomainError('LIMIT_BELOW_SPENT', 'Das neue Limit liegt unter dem bereits verbrauchten Betrag', 409);
export const idempotencyConflict = () =>
  new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key wurde bereits mit anderen Daten verwendet', 422);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_CENTS = 1_000_000; // 10.000 EUR als Obergrenze gegen Tippfehler

// IDs landen in DynamoDB-Schlüsseln (z. B. "T#acme#E#emp-1"). Das Muster verhindert,
// dass jemand per "#" in fremde Schlüsselräume springt.
export function assertId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw validationError(`${name} ist ungültig (erlaubt: A-Z, a-z, 0-9, _ und -, max. 64 Zeichen)`);
  }
  return value;
}

export function assertMonth(value: unknown): Month {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw validationError('month muss das Format YYYY-MM haben');
  }
  return value;
}

export function assertCents(value: unknown, name: string, { allowZero = false } = {}): number {
  const min = allowZero ? 0 : 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > MAX_CENTS) {
    throw validationError(`${name} muss eine ganze Zahl in Cent zwischen ${min} und ${MAX_CENTS} sein`);
  }
  return value;
}

const isCategory = (value: unknown): value is Category =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);

// Request-Bodies kommen als unbekanntes JSON an und werden hier zu geprüften Typen.
type Json = Record<string, unknown>;

export function parseBudgetInput(body: Json): BudgetInput {
  return { limitCents: assertCents(body.limitCents, 'limitCents', { allowZero: true }) };
}

export function parseExpenseInput(body: Json): ExpenseInput {
  const month = assertMonth(body.month);
  const amountCents = assertCents(body.amountCents, 'amountCents');
  if (!isCategory(body.category)) {
    throw validationError(`category muss eine von ${CATEGORIES.join(', ')} sein`);
  }
  const description = body.description ?? '';
  if (typeof description !== 'string' || description.length > 200) {
    throw validationError('description darf höchstens 200 Zeichen lang sein');
  }
  return { month, amountCents, category: body.category, description };
}
