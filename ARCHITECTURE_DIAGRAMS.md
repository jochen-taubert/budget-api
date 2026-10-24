# Mobility Budget API - Architecture Diagrams

## 1. DEPLOYMENT ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────┐
│                            AWS ACCOUNT                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────┐        ┌─────────────────────────────┐  │
│  │   Internet Clients   │        │    CloudWatch Logs          │  │
│  │   (Web/Mobile/CLI)   │        │  ├─ /aws/lambda/{proj}      │  │
│  └──────────┬───────────┘        │  └─ /aws/apigateway/{proj}  │  │
│             │                    └─────────────────────────────┘  │
│             │ HTTPS                                                │
│             ▼                                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │           API Gateway (HTTP API, v2 Payload)               │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │  ┌─────────────────────────────────────────────────────┐   │  │
│  │  │  JWT Authorizer (Optional)                          │   │  │
│  │  │  • Verify signature via JWKS                        │   │  │
│  │  │  • Check exp/nbf (expiry/not-before)               │   │  │
│  │  │  • Validate iss (issuer) & aud (audience)          │   │  │
│  │  │  • Extract & enforce scopes                        │   │  │
│  │  └─────────────────────────────────────────────────────┘   │  │
│  │                                                             │  │
│  │  Routes:                                                   │  │
│  │  • PUT  /employees/{id}/budgets/{month}   budget:admin    │  │
│  │  • GET  /employees/{id}/budgets/{month}   budget:read     │  │
│  │  • POST /employees/{id}/expenses          expense:write   │  │
│  │                                                             │  │
│  │  Throttling: 50 req/sec, 100 burst                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│             │                                                       │
│             │ AWS_PROXY integration                                │
│             ▼                                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Lambda Function (nodejs22.x, arm64, 256MB, 10s timeout)   │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │  • Handler: index.handler (dist/index.mjs)               │  │
│  │  • Environment:                                           │  │
│  │    - TABLE_NAME=<table>                                  │  │
│  │    - AUTH_MODE=none|jwt                                  │  │
│  │    - NODE_OPTIONS=--enable-source-maps                   │  │
│  │                                                             │  │
│  │  Code Flow:                                               │  │
│  │  1. Parse request (app.ts)                               │  │
│  │  2. Extract caller info (JWT claims or headers)          │  │
│  │  3. Route to handler (budget/expense operation)          │  │
│  │  4. Validate input (domain.ts)                           │  │
│  │  5. Authorize access (tenant, employee, admin)           │  │
│  │  6. Execute repository method (DynamoDB)                 │  │
│  │  7. Return response or error                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│             │                                                       │
│             │ BatchGetItem, Query, UpdateItem, TransactWrite      │
│             ▼                                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │       DynamoDB Table (On-Demand, Single Table)             │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │  Table: {project}-budgets                                │  │
│  │  • Billing: PAY_PER_REQUEST                             │  │
│  │  • PK: T#<tenant>#E#<employee> (Partition Key)          │  │
│  │  • SK: BUDGET#|TX#|IDEMP# (Sort Key)                    │  │
│  │  • TTL: On 'ttl' attribute (idempotency cleanup)        │  │
│  │  • PITR: Enabled (Point-in-Time Recovery)              │  │
│  │  • Encryption: Enabled (AWS-managed)                    │  │
│  │                                                             │  │
│  │  Item Types:                                             │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │ BUDGET#2026-10 (Monthly Budget Record)         │    │  │
│  │  │ {                                               │    │  │
│  │  │   pk: "T#acme#E#emp-1"                         │    │  │
│  │  │   sk: "BUDGET#2026-10"                         │    │  │
│  │  │   limitCents: 13500                            │    │  │
│  │  │   spentCents: 5800                             │    │  │
│  │  │   remainingCents: 7700                         │    │  │
│  │  │   currency: "EUR"                              │    │  │
│  │  │   updatedAt: "2026-10-23T09:00:00Z"            │    │  │
│  │  │ }                                               │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │ TX#2026-10#2026-10-23T09:01:00Z#<uuid>        │    │  │
│  │  │ (Transaction/Expense Record)                   │    │  │
│  │  │ {                                               │    │  │
│  │  │   pk: "T#acme#E#emp-1"                         │    │  │
│  │  │   sk: "TX#2026-10#<createdAt>#<id>"           │    │  │
│  │  │   type: "EXPENSE"                              │    │  │
│  │  │   month: "2026-10"                             │    │  │
│  │  │   amountCents: 5800                            │    │  │
│  │  │   category: "OEPNV"                            │    │  │
│  │  │   description: "Deutschlandticket"             │    │  │
│  │  │   createdAt: "2026-10-23T09:01:00Z"            │    │  │
│  │  │ }                                               │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │ IDEMP#<idempotency-key>                         │    │  │
│  │  │ (Idempotency Marker, 7-day TTL)                │    │  │
│  │  │ {                                               │    │  │
│  │  │   pk: "T#acme#E#emp-1"                         │    │  │
│  │  │   sk: "IDEMP#beleg-4711"                       │    │  │
│  │  │   txSk: "TX#2026-10#<createdAt>#<id>"         │    │  │
│  │  │   fingerprint: "<sha256>"                      │    │  │
│  │  │   ttl: <unix-timestamp-in-future>             │    │  │
│  │  │ }                                               │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  IAM Least-Privilege Role:                                        │
│  • dynamodb:GetItem, PutItem, UpdateItem, Query (only budgets)   │
│  • logs:CreateLogStream, PutLogEvents (only Lambda log group)    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. REQUEST/RESPONSE FLOW

```
┌─────────────┐
│   Client    │
│ (curl, SDK) │
└──────┬──────┘
       │
       │ POST /employees/emp-1/expenses
       │ {
       │   "month": "2026-10",
       │   "amountCents": 5800,
       │   "category": "OEPNV",
       │   "description": "Deutschlandticket",
       │   "Idempotency-Key": "beleg-4711"
       │ }
       ▼
┌──────────────────────────────────────┐
│  API Gateway                         │
│  1. Parse request                    │
│  2. Verify JWT signature (if enabled)│
│  3. Check scopes (expense:write)    │
└──────┬───────────────────────────────┘
       │ Valid
       ▼
┌──────────────────────────────────────────────────┐
│  Lambda (index.ts)                               │
│  • Parse event                                   │
│  • Extract caller (JWT claims or header)        │
│  • Route to handler                             │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  app.ts Handler                                  │
│  • Extract: employeeId from path                │
│  • Validate: employeeId, month, amounts         │
│  • Parse: body as ExpenseInput                  │
│  • Check: caller can access this employee      │
│  • Call: repo.bookExpense(...)                 │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  repository.ts (DynamoDB Adapter)               │
│                                                  │
│  TransactWriteItems (Atomic):                   │
│  1. Update Budget:                              │
│     - Condition: remainingCents >= 5800        │
│     - Action: decrement remaining, +spent      │
│  2. Put Expense:                                │
│     - Condition: !exists(pk+sk)                │
│     - Action: insert new expense record        │
│  3. Put Idempotency Marker:                     │
│     - Condition: !exists(pk+sk)                │
│     - Action: insert marker with 7-day TTL    │
└──────┬───────────────────────────────────────────┘
       │
       │ All conditions pass:
       ▼
┌──────────────────────────────────────────────────┐
│  DynamoDB                                        │
│  Transaction committed                          │
│  • Budget: remainingCents -= 5800               │
│  • Expense: new TX#... record                   │
│  • Idempotency: marker set, expires in 7 days  │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  Lambda returns success                          │
│  Status: 201 Created                            │
│  Body: Expense object with ID, timestamps       │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  API Gateway                                     │
│  Status: 201                                     │
│  Headers: Content-Type: application/json        │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  Client receives:                                │
│  201 Created                                     │
│  {                                               │
│    "id": "a1b2c3d4-...",                       │
│    "month": "2026-10",                          │
│    "amountCents": 5800,                         │
│    "category": "OEPNV",                         │
│    "description": "Deutschlandticket",          │
│    "createdAt": "2026-10-23T09:01:23Z"         │
│  }                                               │
└──────────────────────────────────────────────────┘
```

---

## 3. IDEMPOTENCY RETRY FLOW

```
Retry Scenario: Same Idempotency-Key

Attempt 1:
┌────────────────────────────┐
│ POST /employees/emp-1/      │
│       expenses              │
│ Idempotency-Key: beleg-4711 │
└────┬───────────────────────┘
     │
     ▼
┌────────────────────────────────────┐
│ DynamoDB Transaction:              │
│ 1. Update Budget (OK)              │
│ 2. Put Expense (OK)                │
│ 3. Put Idempotency Marker (OK)     │
│ ✓ COMMITTED                        │
└────┬───────────────────────────────┘
     │
     ▼
┌────────────────────────────────────┐
│ Response 201 Created               │
│ {                                  │
│   "id": "uuid-123",                │
│   ...                              │
│ }                                  │
└────────────────────────────────────┘
     │
     ✗ Network timeout / client retry


Attempt 2 (Retry):
┌────────────────────────────┐
│ POST /employees/emp-1/      │
│       expenses              │
│ Idempotency-Key: beleg-4711 │
│ (Same data)                 │
└────┬───────────────────────┘
     │
     ▼
┌────────────────────────────────────────────┐
│ DynamoDB Transaction:                      │
│ 1. Update Budget: Condition Check OK       │
│ 2. Put Expense: Condition FAILED           │
│    → SK already exists from Attempt 1      │
│ 3. Put Idempotency Marker: Condition FAILED│
│    → SK already exists from Attempt 1      │
│ ✗ ROLLED BACK (all-or-nothing)            │
│   TransactionCanceledException raised      │
└────┬───────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────┐
│ Lambda Error Handler:                      │
│ Check failure at index 2:                  │
│ → Idempotency marker failed                │
│ → Fetch marker & verify fingerprint        │
│ → Return original expense with 200         │
└────┬───────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────┐
│ Response 200 OK (Replay)                   │
│ Headers: idempotent-replay: true           │
│ Body: Original expense {id: "uuid-123"}   │
│ ✓ Budget NOT double-charged                │
└────────────────────────────────────────────┘


Misuse Scenario: Same Idempotency-Key, Different Data
┌────────────────────────────────────────┐
│ POST /employees/emp-1/expenses          │
│ amountCents: 9999 (different!)          │
│ Idempotency-Key: beleg-4711             │
└────┬───────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────┐
│ Lambda:                                    │
│ Fetch idempotency marker                   │
│ Compute new fingerprint(9999, ...)        │
│ Compare:                                   │
│   new fingerprint != stored fingerprint   │
│ → Conflicting use of same key              │
└────┬───────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────┐
│ Response 422 Unprocessable Entity          │
│ {                                          │
│   "code": "IDEMPOTENCY_CONFLICT",         │
│   "message": "Idempotency-Key bereits ...  │
│ }                                          │
└────────────────────────────────────────────┘
```

---

## 4. AUTHORIZATION FLOW (JWT MODE)

```
┌──────────────────┐
│ Identity Provider│ (Keycloak, Cognito)
│ (OIDC Compliant) │
└──────┬───────────┘
       │ Issue JWT token
       │ {
       │   "iss": "https://auth.example.de/...",
       │   "aud": "benefits-api",
       │   "tenant": "acme",
       │   "employee_id": "emp-1",
       │   "scope": "openid budget:read expense:write",
       │   "exp": <future-timestamp>,
       │   "nbf": <past-timestamp>,
       │   "iat": <issued-at>,
       │   "sub": "user-123"
       │ }
       │
       ▼
┌───────────────────────────────────────┐
│ Client                                │
│ Stores JWT in Authorization header   │
└───────┬───────────────────────────────┘
        │
        │ GET /employees/emp-1/budgets/2026-10
        │ Authorization: Bearer <jwt-token>
        │
        ▼
┌───────────────────────────────────────────────────────┐
│ API Gateway JWT Authorizer                           │
├───────────────────────────────────────────────────────┤
│ 1. Extract JWT from Authorization header             │
│ 2. Fetch public key set (JWKS) from issuer URL      │
│ 3. Verify signature with public key                  │
│ 4. Check expiration (exp > now)                      │
│ 5. Check not-before (nbf <= now)                     │
│ 6. Verify issuer (iss == configured oidc_issuer)    │
│ 7. Verify audience (aud contains benefits-api)      │
│ 8. Extract scopes from scope claim                   │
│ 9. Check scopes for requested route                  │
│    Route needs [budget:read]                         │
│    Scopes has [budget:read] → PASS                   │
│                                                       │
│ Result: Claims context passed to Lambda              │
└───────┬──────────────────────────────────────────────┘
        │ Authorized
        ▼
┌───────────────────────────────────────────────────────┐
│ Lambda (app.ts) - Finer Authorization               │
│                                                       │
│ resolveCaller(event) {                              │
│   const claims = event.requestContext.authorizer... │
│   return {                                           │
│     tenant: claims.tenant,      // "acme"           │
│     employeeId: claims.employee_id,  // "emp-1"     │
│     isAdmin: scopes.includes('budget:admin')        │
│   }                                                  │
│ }                                                    │
│                                                       │
│ assertMayAccess(caller, pathEmployeeId) {           │
│   if (caller.isAdmin) return;  // HR can see all    │
│   if (caller.employeeId !== pathEmployeeId)         │
│     throw forbidden(...)        // Can only see own  │
│ }                                                    │
│                                                       │
│ Processing /employees/emp-1/budgets/2026-10:       │
│ • Caller.employeeId = "emp-1"                       │
│ • Path.employeeId = "emp-1"                         │
│ • Match → Allowed                                    │
└───────┬──────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────┐
│ DynamoDB Query                                        │
│ PK = T#acme#E#emp-1                                 │
│ (tenant from JWT, employee from JWT, both secured)  │
│                                                       │
│ ✓ Tenant cannot be spoofed via header               │
│ ✓ Employee cannot access other employees' data      │
│ ✓ Admins can access any employee within tenant      │
└───────────────────────────────────────────────────────┘
```

---

## 5. CODE LAYERING (PORTS & ADAPTERS)

```
┌────────────────────────────────────────────────────────────┐
│                    LAMBDA ENTRY POINT                      │
│                       index.ts                             │
├────────────────────────────────────────────────────────────┤
│ • Create DynamoDB Document Client (reused warm calls)      │
│ • Create Repository (DynamoDB adapter)                     │
│ • Create Handler (app.ts, with dependency injection)       │
│ • Export handler function for Lambda runtime              │
└────────────────────────────────────────────────────────────┘
                            │
                            │ Passes repo & authMode
                            ▼
┌────────────────────────────────────────────────────────────┐
│              HTTP/REQUEST LAYER (PORT)                     │
│                       app.ts                               │
├────────────────────────────────────────────────────────────┤
│ • Handler function: (ApiEvent) → Promise<ApiResult>        │
│ • Routes: Maps routeKey to async handlers                  │
│ • Input Parsing: JSON body → Record<string, unknown>       │
│ • Authorization: resolveCaller(event, authMode)            │
│ • Error Handling: DomainError → HTTP status codes          │
│ • Response Mapping: Objects → JSON responses               │
│                                                             │
│ Routes use repository (abstract interface):                │
│ - await repo.setBudget(...)                                │
│ - await repo.getMonth(...)                                 │
│ - await repo.bookExpense(...)                              │
└────────────────────────────────────────────────────────────┘
                            │
                            │ Uses BudgetRepository interface
                            ▼
┌────────────────────────────────────────────────────────────┐
│           DOMAIN/BUSINESS LOGIC LAYER (PORT)               │
│                      domain.ts                             │
├────────────────────────────────────────────────────────────┤
│ Types (Entities):                                          │
│   • Budget, Expense, MonthView, ExpenseInput, BudgetInput │
│                                                             │
│ Interface (Contract):                                      │
│   • BudgetRepository (no AWS dependencies)                 │
│     - setBudget(tenant, employee, month, input)           │
│     - getMonth(tenant, employee, month)                    │
│     - bookExpense(tenant, employee, input, idempKey)      │
│                                                             │
│ Validation Functions:                                      │
│   • assertId(value, name)                                  │
│   • assertMonth(value)                                     │
│   • assertCents(value, name)                               │
│   • parseExpenseInput(body)                                │
│   • parseBudgetInput(body)                                 │
│                                                             │
│ Error Model:                                               │
│   • DomainError(code, message, status, details?)          │
│   • Factory functions: validationError(), forbidden(), ... │
│                                                             │
│ Business Rules:                                            │
│   • CATEGORIES enum (OEPNV, BAHN, FAHRRAD, ...)          │
│   • ID pattern: [A-Za-z0-9_-]{1,64}                       │
│   • Month format: YYYY-MM                                  │
│   • MAX_CENTS: 1,000,000                                  │
└────────────────────────────────────────────────────────────┘
                            │
                            │ Implements BudgetRepository
                            ▼
┌────────────────────────────────────────────────────────────┐
│       DYNAMODB ADAPTER LAYER (IMPLEMENTATION)              │
│                   repository.ts                            │
├────────────────────────────────────────────────────────────┤
│ • Implements BudgetRepository interface                    │
│ • DynamoDB-specific operations:                            │
│   - GetCommand(Key: {pk, sk})                              │
│   - QueryCommand(KeyConditionExpression, ...)             │
│   - UpdateCommand(...)                                     │
│   - TransactWriteCommand([...])                            │
│                                                             │
│ • Single-table item types:                                │
│   - BUDGET#<month>      (monthly limit & spent)            │
│   - TX#<month>#...#...  (transaction/expense)             │
│   - IDEMP#<key>         (idempotency marker)              │
│                                                             │
│ • Conversions:                                             │
│   - BudgetItem → Budget (entity mapping)                   │
│   - ExpenseItem → Expense (entity mapping)                 │
│                                                             │
│ • Conditions & Atomicity:                                  │
│   - Budget update: remainingCents >= amount               │
│   - Transactions: all-or-nothing writes                    │
│   - TTL cleanup: idempotency markers after 7 days         │
└────────────────────────────────────────────────────────────┘
                            │
                            │ DynamoDBDocumentClient.send()
                            ▼
┌────────────────────────────────────────────────────────────┐
│          AWS SDK & DATA STORAGE (ADAPTERS)                 │
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │  @aws-sdk/lib-dynamodb                             │   │
│  │  DynamoDBDocumentClient                            │   │
│  │  (High-level interface, handles marshalling)       │   │
│  └────────────────────────────────────────────────────┘   │
│                            │                               │
│  ┌────────────────────────────────────────────────────┐   │
│  │  @aws-sdk/client-dynamodb                          │   │
│  │  DynamoDBClient                                    │   │
│  │  (Low-level wire protocol)                         │   │
│  └────────────────────────────────────────────────────┘   │
│                            │                               │
│  ┌────────────────────────────────────────────────────┐   │
│  │  AWS DynamoDB Service                              │   │
│  │  Partition: T#<tenant>#E#<employee>                │   │
│  │  Sort Key: BUDGET#|TX#|IDEMP#                      │   │
│  └────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘


TESTING: Swap Adapter
┌────────────────────────────────────────────────────────────┐
│          FAKE DYNAMODB (IN-MEMORY, TEST ONLY)              │
│                    fake-dynamo.ts                          │
├────────────────────────────────────────────────────────────┤
│ • Implements same interface as DynamoDBDocumentClient      │
│ • In-memory Map<string, Item>                              │
│ • Simulates:                                               │
│   - Condition checks (attribute_exists, >=)               │
│   - Transactional rollback on condition failure            │
│   - Pagination (with configurable page size)              │
│ • Records sent commands for assertions                     │
│                                                             │
│ Used in test/api.test.ts:                                  │
│   const db = createFakeDynamo()                            │
│   const repo = createRepository({ db, tableName: '...' }) │
│   const handler = createHandler({ repo })                 │
│   // No AWS credentials needed                             │
└────────────────────────────────────────────────────────────┘
```

---

## 6. FILE UPLOAD (S3) INTEGRATION POINTS

```
Future Enhancement: Receipt/Document Upload

┌──────────────────────────────────────────────────────────────┐
│              PLANNED S3 INTEGRATION LAYER                    │
├──────────────────────────────────────────────────────────────┤
│  New files to create:                                        │
│  • src/s3-adapter.ts         (S3 client wrapper)            │
│  • src/upload.ts             (File upload service)          │
│  • test/fake-s3.ts           (In-memory S3 mock)            │
│                                                              │
│  Modifications:                                              │
│  • src/index.ts              (Create S3Client)              │
│  • src/app.ts                (Add upload routes)            │
│  • src/domain.ts             (Add upload types/validation)  │
│  • src/repository.ts         (Add RECEIPT# items)           │
│  • infra/main.tf             (Add S3 bucket, IAM)          │
│  • test/api.test.ts          (Add upload tests)             │
└──────────────────────────────────────────────────────────────┘

Flow:

┌──────────────┐
│  Client App  │
└──────┬───────┘
       │
       │ 1. POST /employees/{id}/expenses/{id}/receipt-upload-url
       │    (Request presigned URL)
       ▼
┌────────────────────────────────────────┐
│  Lambda (app.ts)                       │
│  • Validate expense exists             │
│  • Check authorization                 │
│  • Call uploadService.generateUrl(...) │
└────────┬───────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│  S3 Adapter (s3-adapter.ts)            │
│  • Generate presigned POST URL         │
│  • Policy: bucket, key, expiration     │
│  • Store metadata in DynamoDB          │
└────────┬───────────────────────────────┘
         │ Return presigned URL
         │ (valid for 15 minutes)
         ▼
┌────────────────────────────────────────┐
│  Client receives URL                   │
│  {                                     │
│    "uploadUrl": "https://s3...",      │
│    "fields": {...}                     │
│  }                                     │
└────────┬───────────────────────────────┘
         │
         │ 2. PUT/POST to presigned URL
         │    (File upload directly to S3)
         ▼
┌────────────────────────────────────────┐
│  S3 Bucket (receipts)                  │
│  Key: {tenant}/{employee}/{expenseId}/ │
│       {filename}                       │
│                                        │
│  Optional: S3 Event → SNS/SQS         │
│  Trigger Lambda for processing        │
│  (virus scan, OCR, archival)          │
└────────────────────────────────────────┘

DynamoDB Extension:
┌────────────────────────────────────────┐
│ Item: RECEIPT#<expenseId>              │
│ {                                      │
│   pk: "T#acme#E#emp-1"                │
│   sk: "RECEIPT#<expenseId>"           │
│   fileKey: "s3://bucket/path/file.pdf"│
│   uploadedAt: "2026-10-23T09:15:00Z"  │
│   fileSize: 245000                     │
│   contentType: "application/pdf"       │
│   metadata: {...}                      │
│ }                                      │
└────────────────────────────────────────┘
```

---

## 7. DEPLOYMENT PIPELINE

```
Developer
┌────────────────────────┐
│  npm install           │
│  npm run typecheck     │  ← TypeScript type checking
│  npm test              │  ← Unit tests (no AWS)
│  npm run build         │  ← esbuild → dist/index.mjs
└────────┬───────────────┘
         │ All pass
         │
         ▼
┌────────────────────────┐
│  make apply            │
│  (= npm run build +    │
│     terraform apply)   │
└────────┬───────────────┘
         │ Builds dist/
         │
         ▼
┌────────────────────────────────────────────────┐
│  Terraform                                     │
│  • archive_file("dist/")                       │
│  • Compute SHA256(lambda.zip)                  │
│  • Compare with previous hash                  │
└────────┬───────────────────────────────────────┘
         │ Hash changed?
         ├─ YES: Update Lambda
         └─ NO: No-op
         │
         ▼
┌────────────────────────────────────────────────┐
│  AWS                                           │
│  • Create/Update Lambda (nodejs22.x)           │
│  • Attach execution role                       │
│  • Set environment variables                   │
│  • Create/Update API Gateway routes            │
│  • Create/Update DynamoDB table                │
└────────┬───────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────┐
│  Outputs                                       │
│  api_url = https://xxxxx.execute-api.region... │
│  table_name = mobility-budget-budgets          │
│  function_name = mobility-budget-api           │
│  auth_mode = jwt|none                          │
└────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────┐
│  make smoke                                    │
│  End-to-end tests against deployed API         │
│  (bash script with curl + jq)                  │
└────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────┐
│  Production Ready                              │
│  Cost: ~$0.02/day typical usage                │
└────────────────────────────────────────────────┘
```

