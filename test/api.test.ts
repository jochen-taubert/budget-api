import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, type ApiEvent, type AuthMode } from '../src/app.ts';
import { createRepository } from '../src/repository.ts';
import type { ExpenseInput } from '../src/domain.ts';
import { createFakeDynamo } from './fake-dynamo.ts';

const PUT_BUDGET = 'PUT /employees/{employeeId}/budgets/{month}';
const GET_BUDGET = 'GET /employees/{employeeId}/budgets/{month}';
const POST_EXPENSE = 'POST /employees/{employeeId}/expenses';

interface CallOptions {
  path?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  claims?: Record<string, string>;
}

function setup({ authMode = 'none' as AuthMode } = {}) {
  const db = createFakeDynamo();
  let seq = 0;
  let clock = Date.parse('2026-10-23T09:00:00Z');
  const repo = createRepository({
    db,
    tableName: 'test-table',
    now: () => new Date((clock += 1000)),
    newId: () => `id-${++seq}`,
  });
  const handler = createHandler({ repo, authMode, log: { error: () => {} } });

  const call = async (routeKey: string, { path = {}, body, headers = {}, claims }: CallOptions = {}) => {
    const event = {
      routeKey,
      pathParameters: path,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: { requestId: 'req-1', authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined },
    } as unknown as ApiEvent;
    const res = await handler(event);
    return { status: res.statusCode, body: JSON.parse(res.body ?? '{}'), headers: res.headers ?? {} };
  };

  return { db, call };
}

const expense = (amountCents: number, extra: Partial<ExpenseInput> | Record<string, unknown> = {}) => ({
  month: '2026-10',
  amountCents,
  category: 'OEPNV',
  description: 'Deutschlandticket',
  ...extra,
});

test('Budget anlegen, buchen, Monatsansicht lesen', async () => {
  const { call } = setup();
  const path = { employeeId: 'emp-1', month: '2026-10' };

  const created = await call(PUT_BUDGET, { path, body: { limitCents: 13500 } });
  assert.equal(created.status, 200);
  assert.deepEqual(
    { limit: created.body.limitCents, spent: created.body.spentCents, remaining: created.body.remainingCents },
    { limit: 13500, spent: 0, remaining: 13500 },
  );

  for (const amount of [5800, 2500, 1200]) {
    const booked = await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(amount) });
    assert.equal(booked.status, 201);
  }

  const view = await call(GET_BUDGET, { path });
  assert.equal(view.status, 200);
  assert.equal(view.body.spentCents, 9500);
  assert.equal(view.body.remainingCents, 4000);
  // 3 Buchungen bei Seitengröße 2: Pagination muss durchlaufen werden
  assert.deepEqual(
    view.body.expenses.map((e: { amountCents: number }) => e.amountCents),
    [5800, 2500, 1200],
  );
});

test('Überziehen wird abgelehnt und ändert nichts', async () => {
  const { call } = setup();
  await call(PUT_BUDGET, { path: { employeeId: 'emp-1', month: '2026-10' }, body: { limitCents: 5000 } });
  await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(4000) });

  const rejected = await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(1500) });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'INSUFFICIENT_BUDGET');
  assert.equal(rejected.body.remainingCents, 1000);

  const view = await call(GET_BUDGET, { path: { employeeId: 'emp-1', month: '2026-10' } });
  assert.equal(view.body.expenses.length, 1);
  assert.equal(view.body.remainingCents, 1000);
});

test('Buchung ohne Budget liefert 404', async () => {
  const { call } = setup();
  const res = await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(100) });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'BUDGET_NOT_FOUND');
});

test('Idempotency-Key: Wiederholung bucht nicht doppelt', async () => {
  const { call } = setup();
  await call(PUT_BUDGET, { path: { employeeId: 'emp-1', month: '2026-10' }, body: { limitCents: 10000 } });
  const headers = { 'idempotency-key': 'beleg-4711' };

  const first = await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(3000), headers });
  const retry = await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(3000), headers });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers['idempotent-replay'], 'true');
  assert.equal(retry.body.id, first.body.id);

  const view = await call(GET_BUDGET, { path: { employeeId: 'emp-1', month: '2026-10' } });
  assert.equal(view.body.spentCents, 3000);

  const misuse = await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(9999), headers });
  assert.equal(misuse.status, 422);
});

test('Limit unter bereits Verbrauchtem wird abgelehnt, Erhöhen klappt', async () => {
  const { call } = setup();
  const path = { employeeId: 'emp-1', month: '2026-10' };
  await call(PUT_BUDGET, { path, body: { limitCents: 5000 } });
  await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(4000) });

  assert.equal((await call(PUT_BUDGET, { path, body: { limitCents: 3000 } })).status, 409);
  const raised = await call(PUT_BUDGET, { path, body: { limitCents: 8000 } });
  assert.equal(raised.body.remainingCents, 4000);
});

test('Validierung: ungültige Eingaben ergeben 400', async () => {
  const { call } = setup();
  const put = (employeeId: string, month: string, body: unknown) => call(PUT_BUDGET, { path: { employeeId, month }, body });
  const post = (body: unknown) => call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body });

  assert.equal((await put('emp-1', '2026-13', { limitCents: 1 })).status, 400);
  assert.equal((await put('a#b', '2026-10', { limitCents: 1 })).status, 400);
  assert.equal((await put('emp-1', '2026-10', { limitCents: '100' })).status, 400);
  assert.equal((await post(expense(10.5))).status, 400);
  assert.equal((await post(expense(100, { category: 'TAXI' }))).status, 400);
  assert.equal((await post([1, 2, 3])).status, 400);
});

test('Mandanten sind getrennt', async () => {
  const { call } = setup();
  const path = { employeeId: 'emp-1', month: '2026-10' };
  await call(PUT_BUDGET, { path, body: { limitCents: 5000 }, headers: { 'x-tenant-id': 'firma-a' } });

  const other = await call(GET_BUDGET, { path, headers: { 'x-tenant-id': 'firma-b' } });
  assert.equal(other.status, 404);
});

test('JWT-Modus: Mandant aus Token, Mitarbeitende sehen nur eigene Daten', async () => {
  const { call } = setup({ authMode: 'jwt' });
  const path = { employeeId: 'emp-1', month: '2026-10' };
  const hr = { tenant: 'firma-a', scope: 'openid budget:admin budget:read' };
  const emp1 = { tenant: 'firma-a', employee_id: 'emp-1', scope: 'openid budget:read' };
  const emp2 = { tenant: 'firma-a', employee_id: 'emp-2', scope: 'openid budget:read' };

  assert.equal((await call(PUT_BUDGET, { path, body: { limitCents: 5000 }, claims: emp1 })).status, 403);
  assert.equal((await call(PUT_BUDGET, { path, body: { limitCents: 5000 }, claims: hr })).status, 200);
  assert.equal((await call(GET_BUDGET, { path, claims: emp1 })).status, 200);
  assert.equal((await call(GET_BUDGET, { path, claims: emp2 })).status, 403);
  assert.equal((await call(GET_BUDGET, { path, claims: { scope: 'budget:read' } })).status, 403);
  // Header darf den Mandanten aus dem Token nicht überschreiben
  const otherTenant = { ...hr, tenant: 'firma-b' };
  assert.equal((await call(GET_BUDGET, { path, claims: otherTenant, headers: { 'x-tenant-id': 'firma-a' } })).status, 404);
});

test('Transaktion enthält Budget-Bedingung gegen Überziehen', async () => {
  const { db, call } = setup();
  await call(PUT_BUDGET, { path: { employeeId: 'emp-1', month: '2026-10' }, body: { limitCents: 5000 } });
  await call(POST_EXPENSE, { path: { employeeId: 'emp-1' }, body: expense(100), headers: { 'idempotency-key': 'k1' } });

  const tx = db.sent.find((c) => c.name === 'TransactWriteCommand')!.input.TransactItems;
  assert.equal(tx.length, 3);
  assert.match(tx[0].Update.ConditionExpression, /remainingCents >= :amt/);
  assert.equal(tx[0].Update.Key.pk, 'T#demo#E#emp-1');
  assert.ok(tx[2].Put.Item.ttl > Date.parse('2026-10-23T00:00:00Z') / 1000);
});
