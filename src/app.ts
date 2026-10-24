import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  DomainError,
  assertId,
  assertMonth,
  forbidden,
  parseBudgetInput,
  parseExpenseInput,
  validationError,
  type BudgetRepository,
} from './domain.ts';

// HTTP-Schicht für API Gateway (HTTP API, Payload-Format 2.0).
// Das Repository wird hereingereicht, damit sich der Handler ohne AWS testen lässt.

export type AuthMode = 'none' | 'jwt';
export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyStructuredResultV2;

interface Caller {
  tenant: string;
  employeeId: string | undefined;
  isAdmin: boolean;
}

type Route = (event: ApiEvent, caller: Caller) => Promise<ApiResult>;

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): ApiResult => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function parseBody(event: ApiEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw validationError('Body ist kein gültiges JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw validationError('Body muss ein JSON-Objekt sein');
  }
  return parsed as Record<string, unknown>;
}

// Wer ruft an? Im JWT-Modus hat das API Gateway Signatur, Ablauf, Issuer, Audience
// und Scopes bereits geprüft. Hier geht es um die fachliche Autorisierung:
// Mandant aus dem Token und "nur eigene Daten", sofern kein Admin-Scope vorliegt.
function resolveCaller(event: ApiEvent, authMode: AuthMode): Caller {
  if (authMode === 'jwt') {
    const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
    if (!claims.tenant) throw forbidden('Token enthält keinen Mandanten (Claim "tenant")');
    const scopes = String(claims.scope ?? '').split(' ');
    return {
      tenant: assertId(claims.tenant, 'tenant'),
      employeeId: claims.employee_id === undefined ? undefined : String(claims.employee_id),
      isAdmin: scopes.includes('budget:admin'),
    };
  }
  // Demo-Modus ohne Authentifizierung: Mandant per Header, alles erlaubt.
  const tenant = event.headers?.['x-tenant-id'] ?? 'demo';
  return { tenant: assertId(tenant, 'x-tenant-id'), employeeId: undefined, isAdmin: true };
}

function assertMayAccess(caller: Caller, employeeId: string): void {
  if (caller.isAdmin) return;
  if (caller.employeeId !== employeeId) throw forbidden('Zugriff nur auf die eigenen Daten erlaubt');
}

export interface HandlerOptions {
  repo: BudgetRepository;
  authMode?: AuthMode;
  log?: Pick<Console, 'error'>;
  uploadHandler?: (tenant: string, employeeId: string, expenseId: string, event: ApiEvent) => Promise<unknown>;
}

export function createHandler({ repo, authMode = 'none', log = console, uploadHandler }: HandlerOptions) {
  const routes: Record<string, Route> = {
    'PUT /employees/{employeeId}/budgets/{month}': async (event, caller) => {
      if (!caller.isAdmin) throw forbidden('Budgets dürfen nur HR-Admins setzen');
      const employeeId = assertId(event.pathParameters?.employeeId, 'employeeId');
      const month = assertMonth(event.pathParameters?.month);
      const budget = await repo.setBudget(caller.tenant, employeeId, month, parseBudgetInput(parseBody(event)));
      return json(200, budget);
    },

    'GET /employees/{employeeId}/budgets/{month}': async (event, caller) => {
      const employeeId = assertId(event.pathParameters?.employeeId, 'employeeId');
      assertMayAccess(caller, employeeId);
      const month = assertMonth(event.pathParameters?.month);
      return json(200, await repo.getMonth(caller.tenant, employeeId, month));
    },

    'POST /employees/{employeeId}/expenses': async (event, caller) => {
      const employeeId = assertId(event.pathParameters?.employeeId, 'employeeId');
      assertMayAccess(caller, employeeId);
      const input = parseExpenseInput(parseBody(event));
      const key = event.headers?.['idempotency-key'];
      if (key !== undefined) assertId(key, 'Idempotency-Key');
      const { expense, replayed } = await repo.bookExpense(caller.tenant, employeeId, input, key);
      return json(replayed ? 200 : 201, expense, replayed ? { 'idempotent-replay': 'true' } : {});
    },

    'POST /employees/{employeeId}/expenses/{expenseId}/documents': async (event, caller) => {
      if (!uploadHandler) {
        return json(501, { code: 'NOT_IMPLEMENTED', message: 'Upload-Funktionalität nicht aktiviert' });
      }
      const employeeId = assertId(event.pathParameters?.employeeId, 'employeeId');
      assertMayAccess(caller, employeeId);
      const expenseId = assertId(event.pathParameters?.expenseId, 'expenseId');
      const document = await uploadHandler(caller.tenant, employeeId, expenseId, event);
      return json(201, document);
    },
  };

  return async function handler(event: ApiEvent): Promise<ApiResult> {
    const route = routes[event.routeKey];
    const requestId = event.requestContext?.requestId;
    if (!route) return json(404, { code: 'NOT_FOUND', message: `Unbekannte Route ${event.routeKey}` });

    try {
      return await route(event, resolveCaller(event, authMode));
    } catch (err) {
      if (err instanceof DomainError) {
        return json(err.status, { code: err.code, message: err.message, ...err.details });
      }
      // Strukturiertes Log: in CloudWatch Logs Insights nach requestId filterbar.
      const { name, message } = err instanceof Error ? err : { name: 'Unknown', message: String(err) };
      log.error(JSON.stringify({ level: 'error', requestId, route: event.routeKey, error: name, message }));
      return json(500, { code: 'INTERNAL_ERROR', message: 'Interner Fehler', requestId });
    }
  };
}
