# Mobility Budget API - Codebase Analysis

## 1. PROJECT OVERVIEW

**Project Name:** mobility-budget-api  
**Type:** Serverless API  
**Primary Language:** TypeScript  
**Runtime:** Node.js 22.x (AWS Lambda)  
**Infrastructure:** AWS Lambda + DynamoDB + API Gateway (HTTP API)  
**IaC Tool:** Terraform  
**Package Manager:** npm  

### Description
A production-grade serverless API for managing employee mobility budgets. Employers set monthly budget limits per employee, and employees book expenses (public transport, rail, bike, car-sharing, scooters) against their budget. Built with TypeScript on AWS Lambda, DynamoDB (Single-Table Design), and API Gateway with optional JWT authorization (Keycloak/Cognito).

---

## 2. TECHNOLOGY STACK

### Runtime & Build
- **Node.js:** 22.18+ (TypeScript native support, no transpiler needed for tests)
- **TypeScript:** 7.0.2 (type-only annotations with `erasableSyntaxOnly`)
- **Build Tool:** esbuild 0.28.2 (bundles to ~13KB, external AWS SDK)
- **Test Framework:** Node.js native test runner (node --test)

### AWS Services
- **Lambda:** nodejs22.x runtime, ARM64 architecture, 256MB memory, 10s timeout
- **DynamoDB:** On-Demand billing, Single-Table design with TTL and Point-in-Time Recovery
- **API Gateway:** HTTP API v2 (not REST API), JWT authorizer support
- **CloudWatch:** Logs with retention, structured JSON logging, access logs
- **IAM:** Least-privilege policies (GetItem, PutItem, UpdateItem, Query only)

### Dependencies
- `@aws-sdk/client-dynamodb` - DynamoDB low-level client
- `@aws-sdk/lib-dynamodb` - Document client wrapper
- `@types/aws-lambda` - Lambda types
- `@types/node` - Node.js types

### Authentication
- Optional JWT authorization via API Gateway
- Supports OIDC providers: Keycloak, Cognito, or any OIDC provider
- Two modes: `none` (demo/open) or `jwt` (production)

---

## 3. PROJECT STRUCTURE

```
mobility-budget-api/
├── src/                          # Source code
│   ├── index.ts                  # Lambda entry point, wires SDK & repository
│   ├── domain.ts                 # Business types, validation, error codes
│   ├── app.ts                    # HTTP routing, authorization, status codes
│   └── repository.ts             # DynamoDB adapter, transactions
├── test/                         # Unit tests
│   ├── api.test.ts              # 9 test cases covering all paths
│   └── fake-dynamo.ts           # In-memory DynamoDB mock for testing
├── infra/                        # Terraform infrastructure
│   ├── versions.tf              # Terraform & provider versions
│   ├── variables.tf             # Input variables
│   ├── main.tf                  # DynamoDB table, Lambda function, IAM
│   ├── api.tf                   # API Gateway, routes, JWT authorizer
│   ├── outputs.tf               # API URL, table name, function name
│   ├── tests/config.tftest.hcl  # Terraform tests with mocked provider
│   ├── backend.tf.example       # Remote state template
│   └── build/                   # Generated Lambda zip (gitignored)
├── scripts/
│   └── smoke.sh                 # End-to-end tests against deployed API
├── dist/                        # Build output (gitignored)
│   └── index.mjs               # Bundled Lambda code
├── package.json                 # NPM scripts, dependencies
├── tsconfig.json               # TypeScript config (erasableSyntaxOnly)
├── Makefile                    # Development commands
├── README.md                   # Comprehensive documentation
└── .gitignore                  # Excludes dist/, infra/build/

```

---

## 4. ARCHITECTURAL PATTERNS

### Ports & Adapters (Hexagonal Architecture)
The codebase follows clean architecture principles:
- **Domain Layer** (`domain.ts`): Pure business logic, no AWS dependencies
  - Types: `Budget`, `Expense`, `MonthView`, `ExpenseInput`, `BudgetInput`
  - Validation functions: `assertId()`, `assertMonth()`, `assertCents()`
  - Error types: `DomainError` (code, status, optional details)
  - Interface: `BudgetRepository` (abstraction from data source)

- **Application Layer** (`app.ts`): HTTP routing, authorization, error handling
  - Maps routes to handlers
  - Parses and validates requests
  - Enforces authorization rules (tenant from JWT, employee access control)
  - Returns HTTP responses with appropriate status codes

- **Infrastructure Layer** (`repository.ts`): DynamoDB adapter
  - Implements `BudgetRepository` interface
  - Handles DynamoDB operations (GetItem, Query, UpdateItem, TransactWrite)
  - Converts between domain types and DynamoDB items

- **Lambda Entry Point** (`index.ts`): Wires everything together
  - Creates DynamoDB client (reused across warm invocations)
  - Creates repository instance
  - Creates handler with dependency injection

### Single-Table Design (DynamoDB)
All data in one table with partition key (PK) and sort key (SK):

```
PK: T#<tenant>#E#<employee>
SK: BUDGET#<YYYY-MM>                      → Budget record (limit, spent, remaining)
SK: TX#<YYYY-MM>#<createdAt>#<id>        → Transaction (expense record), chronologically sortable
SK: IDEMP#<idempotencyKey>                → Idempotency marker, auto-deleted via TTL
```

**Benefits:**
- All data for a month's view in one partition → single GetItem + Query
- Chronological ordering of transactions via SK
- No index scanning; pagination within single partition key
- Tight consistency via transactional writes

### Transactional Integrity
Expense booking uses `TransactWriteItems`:
1. Update budget (decrement remaining, increment spent) with condition: `remainingCents >= amount`
2. Put new expense record with condition: `!exists(pk)`
3. Put idempotency marker with TTL (7 days) with condition: `!exists(pk)`

Either all succeed or all fail—no double-bookings, no race conditions.

### Idempotency
- Optional `Idempotency-Key` header (validated as alphanumeric + `_-`)
- Hash fingerprint of request (month + amount + category + description)
- On retry with same key and data: returns original expense with `200` + `idempotent-replay: true` header
- On retry with same key but different data: `422 UNPROCESSABLE_ENTITY` (conflict)
- Marker expires after 7 days via TTL

### Authorization Model (Two-Level)
1. **API Gateway (JWT mode):**
   - Verifies JWT signature via JWKS
   - Checks expiration (exp/nbf)
   - Validates issuer (iss)
   - Validates audience (aud)
   - Extracts scopes and enforces per-route scope requirements

2. **Lambda (Application Logic):**
   - Validates `tenant` claim in JWT
   - Enforces "access only own data" unless `budget:admin` scope
   - No data can be filtered; access is all-or-nothing

### Mandant Separation
- In JWT mode: tenant comes exclusively from the `tenant` claim; headers are ignored
- In demo mode: tenant from `x-tenant-id` header (defaults to `"demo"`)
- IDs restricted to `[A-Za-z0-9_-]` to prevent `#` injection into partition keys

---

## 5. API ENDPOINTS

| Method | Path | Purpose | Required Scope (JWT) | Input |
|--------|------|---------|-----|-------|
| `PUT` | `/employees/{employeeId}/budgets/{month}` | Set budget for a month | `budget:admin` | `{"limitCents": number}` |
| `GET` | `/employees/{employeeId}/budgets/{month}` | Get budget + all expenses for month | `budget:read` | (none) |
| `POST` | `/employees/{employeeId}/expenses` | Book an expense | `expense:write` | `{"month", "amountCents", "category", "description"}` |

### Response Structure
All responses are JSON with `Content-Type: application/json`.

**Success (2xx):**
```json
// Budget response
{
  "month": "2026-10",
  "limitCents": 13500,
  "spentCents": 5800,
  "remainingCents": 7700,
  "currency": "EUR",
  "updatedAt": "2026-10-23T09:00:00Z"
}

// Month view response (GET budget)
{
  "month": "2026-10",
  "limitCents": 13500,
  "spentCents": 5800,
  "remainingCents": 7700,
  "currency": "EUR",
  "updatedAt": "2026-10-23T09:00:00Z",
  "expenses": [
    {
      "id": "uuid",
      "month": "2026-10",
      "amountCents": 5800,
      "category": "OEPNV",
      "description": "Deutschlandticket",
      "createdAt": "2026-10-23T09:00:01Z"
    }
  ]
}

// Expense response (201 Created or 200 with idempotent-replay header)
{
  "id": "uuid",
  "month": "2026-10",
  "amountCents": 5800,
  "category": "OEPNV",
  "description": "Deutschlandticket",
  "createdAt": "2026-10-23T09:00:01Z"
}
```

**Error (4xx/5xx):**
```json
{
  "code": "INSUFFICIENT_BUDGET",
  "message": "Das Budget reicht für diese Buchung nicht aus",
  "remainingCents": 1000  // optional, context-dependent
}
```

---

## 6. DOMAIN LAYER (Business Logic)

### Constants
```typescript
CATEGORIES = ['OEPNV', 'BAHN', 'FAHRRAD', 'CARSHARING', 'SCOOTER']
MAX_CENTS = 1_000_000  // 10,000 EUR limit to catch typos
ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/  // YYYY-MM format
```

### Error Codes
- `VALIDATION_ERROR` (400)
- `FORBIDDEN` (403)
- `BUDGET_NOT_FOUND` (404)
- `INSUFFICIENT_BUDGET` (409)
- `LIMIT_BELOW_SPENT` (409)
- `IDEMPOTENCY_CONFLICT` (422)
- `INTERNAL_ERROR` (500, logged to CloudWatch)

### Validation Rules
- IDs: alphanumeric + underscore/hyphen, max 64 chars (security: prevents key injection)
- Month: `YYYY-MM` format only
- Cents: integer, >= 1 (or >= 0 for budget limits), <= 1,000,000
- Category: must be one of the predefined categories
- Description: string, max 200 chars
- Idempotency-Key: must match ID pattern if provided

---

## 7. TESTING STRATEGY

### Unit Tests (9 test cases)
Located in `/test/api.test.ts`:
1. Basic flow: budget → expenses → month view
2. Insufficient budget rejection
3. Booking without budget (404)
4. Idempotency: replay detection
5. Budget limit conflicts
6. Input validation
7. Tenant separation
8. JWT authorization (admin access, employee row-level access)
9. Transactional integrity

### Test Infrastructure
- **Fake DynamoDB** (`fake-dynamo.ts`): In-memory mock implementing DynamoDB semantics
  - Handles GetItem, Query, UpdateItem, TransactWrite
  - Validates conditions (attribute_exists, attribute_not_exists, >=)
  - Simulates pagination with configurable page size
  - Records all sent commands for assertion

- **Dependency Injection:** Handler and repository are instantiated with mock time + ID generator for deterministic tests

### Running Tests
```bash
npm test  # node --test test/*.test.ts (no build step needed)
```

---

## 8. INFRASTRUCTURE (Terraform)

### Files
- `versions.tf`: Terraform >= 1.7, AWS provider >= 6.0, archive provider
- `variables.tf`: Inputs (project_name, aws_region, auth_mode, etc.)
- `main.tf`: DynamoDB table, Lambda function, IAM roles/policies, CloudWatch logs
- `api.tf`: API Gateway, routes, JWT authorizer
- `outputs.tf`: API URL, table name, function name

### Key Resources

#### DynamoDB Table
- **Name:** `{project_name}-budgets`
- **Billing:** PAY_PER_REQUEST (On-Demand)
- **Keys:** PK (string), SK (string)
- **TTL:** Enabled on `ttl` attribute (idempotency cleanup)
- **PITR:** Enabled (disaster recovery)
- **Encryption:** Enabled (default AWS-managed keys)
- **Deletion Protection:** Configurable (default: false, recommended true for production)

#### Lambda Function
- **Runtime:** `nodejs22.x`
- **Architecture:** `arm64` (cost-efficient)
- **Memory:** 256 MB
- **Timeout:** 10 seconds
- **Handler:** `index.handler` (entry point in dist/index.mjs)
- **Environment Variables:**
  - `TABLE_NAME`: DynamoDB table name
  - `AUTH_MODE`: "none" or "jwt"
  - `NODE_OPTIONS`: "--enable-source-maps" (for TypeScript source in errors)

#### IAM Policy (Least Privilege)
- DynamoDB: GetItem, PutItem, UpdateItem, Query (only on budget table)
- CloudWatch Logs: CreateLogStream, PutLogEvents (only for Lambda log group)

#### API Gateway (HTTP API)
- **Protocol:** HTTP (not REST)
- **Authorizer:** JWT (optional, based on auth_mode)
- **Routes:** 3 routes with scope requirements
- **Throttling:** 50 req/sec (default), 100 burst
- **Access Logs:** CloudWatch Logs with requestId, route, status, latency, auth errors

---

## 9. BUILD & DEPLOYMENT

### Build Process
1. `npm run build` → esbuild bundles `src/index.ts` to `dist/index.mjs`
   - Platform: Node.js
   - Target: Node 22
   - Format: ESM
   - External: AWS SDK (provided by Lambda runtime)
   - Output: ~13 KB (small & fast cold start)

2. `terraform plan/apply` in `infra/`
   - Creates `archive_file` of `dist/` directory
   - Archives to `infra/build/lambda.zip`
   - Computes base64 SHA256 hash for change detection
   - Updates Lambda if hash changes

### Development Workflow
```bash
npm install        # Install dependencies
npm run typecheck  # tsc (type checking only, no emit)
npm test           # node --test (unit tests)
npm run build      # esbuild (Lambda bundle)
npm run check      # All three combined

cd infra
terraform init     # Initialize providers
terraform plan     # Dry-run
terraform apply    # Deploy
```

### Deployment Outputs
- `api_url`: Base URL for API calls (from API Gateway stage)
- `table_name`: DynamoDB table name
- `function_name`: Lambda function name
- `auth_mode`: Current auth mode

---

## 10. LOGGING & OBSERVABILITY

### Lambda Logs
- **Format:** Text (or JSON via `LOG_FORMAT`)
- **Group:** `/aws/lambda/{project_name}-api`
- **Retention:** Configurable (default 14 days)
- **Structured Errors:** JSON with requestId, route, error name, message
- **Source Maps:** NODE_OPTIONS enables TypeScript line numbers

### API Gateway Access Logs
- **Format:** JSON
- **Group:** `/aws/apigateway/{project_name}-api`
- **Fields:** requestId, routeKey, status, latencyMs, authError, integrationMs
- **Retention:** Same as Lambda logs

### CloudWatch Logs Insights Queries
```
fields @timestamp, requestId, @message | filter error
fields @timestamp, routeKey, @duration | stats avg(@duration) by routeKey
fields @timestamp, status | stats count() by status
```

---

## 11. SECURITY HIGHLIGHTS

### Input Validation
- All IDs restricted to `[A-Za-z0-9_-]` to prevent key injection
- Month format strictly enforced (`YYYY-MM`)
- Amounts are integers in cents (no floating-point arithmetic)
- Categories are enum-validated (union type)
- Descriptions limited to 200 chars

### Authorization
- Tenant isolation: tenant comes from JWT (immutable per request)
- Row-level access control: non-admins see only their own employee ID
- Admin detection: `budget:admin` scope from JWT
- Scope enforcement: API Gateway checks required scopes before Lambda

### Data Integrity
- Transactional writes prevent double-bookings
- Idempotency prevents application-level retries from causing duplicates
- TTL cleans up idempotency markers automatically
- Conditions prevent budget overdraws and invalid limit changes

### Least Privilege
- Lambda IAM role has only required DynamoDB actions
- No S3, SNS, SQS, or other services
- No wildcard resources; limited to specific table
- Log access scoped to specific log group

---

## 12. EXISTING FILE UPLOAD FUNCTIONALITY

**Current Status:** None  
**Mentioned as Future Work:** Yes

The README.md explicitly lists as "**Bewusst weggelassen**" (intentionally omitted):
- **Belege-Upload** (Receipt/Document Upload): S3 + presigned URL + SQS processing

This is documented as "the next logical step" (`der nächste logische Schritt`).

---

## 13. S3 INTEGRATION POINTS & RECOMMENDATIONS

### 1. **Where to Add S3**
Based on the current architecture, S3 integration should be added as:

#### A. **File Upload Service** (`src/upload.ts`)
- Accept file uploads via API endpoint: `POST /employees/{employeeId}/expenses/{expenseId}/receipt`
- Generate presigned POST URL for S3 bucket
- Store upload metadata (expenseId, fileKey, uploadedAt) in DynamoDB
- Triggered by expense booking, optional but encouraged

#### B. **Repository Extension** (`src/repository.ts`)
- Extend `BudgetRepository` interface with new methods:
  ```typescript
  interface BudgetRepository {
    // ... existing methods
    generateUploadUrl(tenant: string, employee: string, expenseId: string): Promise<PresignedUploadUrl>;
    recordUpload(tenant: string, employee: string, expenseId: string, fileKey: string): Promise<void>;
    getReceiptUrl(tenant: string, employee: string, expenseId: string): Promise<string | null>;
  }
  ```

#### C. **S3 Adapter** (`src/s3-adapter.ts`)
- Handles presigned URL generation
- Manages S3 bucket policy (public read, authenticated write)
- Metadata storage in DynamoDB `RECEIPT#` items

### 2. **DynamoDB Extension**
Add to single-table design:
```
PK: T#<tenant>#E#<employee>
SK: RECEIPT#<expenseId>              → File metadata (fileKey, uploadedAt, size, contentType)
```

### 3. **IAM Policy Extension**
Add to Lambda role:
```hcl
statement {
  sid       = "S3Upload"
  actions   = ["s3:PutObject", "s3:GetObject"]  # For presigned URLs
  resources = ["${aws_s3_bucket.receipts.arn}/*"]
}
```

### 4. **Infrastructure Addition** (`infra/main.tf`)
```hcl
resource "aws_s3_bucket" "receipts" {
  bucket = "${local.name}-receipts"
  # Versioning, encryption, access logging
}

resource "aws_s3_bucket_cors_configuration" "receipts" {
  # Allow CORS for web uploads
}
```

### 5. **API Routes**
- `POST /employees/{employeeId}/expenses/{expenseId}/receipt-upload-url` → presigned POST URL
- `GET /employees/{employeeId}/expenses/{expenseId}/receipt-url` → get receipt download URL
- `DELETE /employees/{employeeId}/expenses/{expenseId}/receipt` → delete receipt

### 6. **Frontend/SDK Integration**
- Client receives presigned POST URL
- Uploads file directly to S3 (no Lambda involvement)
- S3 Event Notification (SNS/SQS) → triggers Lambda for processing
- Lambda validates, scans (virus, OCR), archives

---

## 14. CONFIGURATION FILES SUMMARY

### `package.json`
- Name: `mobility-budget-api`
- Version: `1.0.0`
- Node requirement: `>= 22.18`
- Scripts: typecheck, test, build, check
- Type: `"module"` (ESM)
- DevDependencies only (no runtime dependencies; SDK is in Lambda runtime)

### `tsconfig.json`
- `erasableSyntaxOnly: true` (no enums, no parameter properties)
- `module: "esnext"` (preserves imports for esbuild)
- `target: "ES2020"`
- Strict mode enabled

### `Makefile`
- `install`: npm install
- `check`: typecheck + test + build
- `typecheck`: tsc type checking
- `test`: node --test
- `build`: esbuild bundle
- `tf-test`: Terraform tests
- `init`, `plan`, `apply`: Terraform commands
- `smoke`: End-to-end tests
- `logs`: Follow Lambda logs
- `destroy`: Terraform destroy

### `.gitignore`
- `dist/` (build output)
- `node_modules/` (dependencies)
- `infra/build/` (Terraform build cache)
- `.idea/` (IDE)
- `.terraform/` (Terraform state)
- `*.tfstate` and `*.tfstate.backup` (Terraform state)

---

## 15. DEPLOYMENT CHECKLIST FOR S3 INTEGRATION

1. **Infrastructure**
   - [ ] Add S3 bucket to `infra/main.tf`
   - [ ] Configure bucket policy (encryption, versioning, CORS)
   - [ ] Extend Lambda IAM policy with S3 permissions

2. **Code**
   - [ ] Create `src/s3-adapter.ts` for S3 client
   - [ ] Extend `src/repository.ts` with upload methods
   - [ ] Add routes in `src/app.ts` for upload endpoints
   - [ ] Add input validation in `src/domain.ts`

3. **DynamoDB**
   - [ ] Extend single-table schema with RECEIPT items
   - [ ] Update repository fake in `test/fake-dynamo.ts`

4. **Testing**
   - [ ] Add S3 mocking to `test/fake-s3.ts`
   - [ ] Add upload integration tests
   - [ ] Update fake-dynamo for RECEIPT items

5. **Documentation**
   - [ ] Update README.md with S3 API endpoints
   - [ ] Document presigned URL flow
   - [ ] Update Terraform outputs with S3 bucket name

---

## 16. ENTRY POINTS FOR ADDING S3

### Primary Entry Point
**File:** `/home/jtaubert/projects/mobility-budget-api/src/index.ts`

Currently creates DynamoDB client. Should also create S3 client here:
```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Adapter } from './s3-adapter.ts';

const s3 = new S3Client({});
const uploadService = createS3Adapter({ s3, bucketName: process.env.S3_BUCKET_NAME });

export const handler = createHandler({ 
  repo: createRepository({ db, tableName }), 
  uploadService,  // Add here
  authMode 
});
```

### Repository Extension
**File:** `/home/jtaubert/projects/mobility-budget-api/src/repository.ts`

Add methods to `BudgetRepository` interface and implementation.

### API Routes
**File:** `/home/jtaubert/projects/mobility-budget-api/src/app.ts`

Add new routes:
```typescript
'POST /employees/{employeeId}/expenses/{expenseId}/receipt-upload-url': async (event, caller) => {
  // Generate presigned URL
},
'GET /employees/{employeeId}/expenses/{expenseId}/receipt-url': async (event, caller) => {
  // Return receipt download URL
}
```

### Infrastructure
**File:** `/home/jtaubert/projects/mobility-budget-api/infra/main.tf`

Add S3 bucket, bucket policies, CORS configuration.

### Environment Variables
**File:** Lambda environment section in `infra/main.tf`

Add:
```hcl
S3_BUCKET_NAME = aws_s3_bucket.receipts.id
```

---

## SUMMARY

The **mobility-budget-api** is a well-architected, production-ready serverless application demonstrating:
- **Clean Architecture**: Ports & adapters with clear separation of concerns
- **Data Integrity**: Transactional writes, idempotency, no race conditions
- **Security**: Least privilege IAM, input validation, tenant isolation
- **Observability**: Structured logging, CloudWatch integration
- **Cost Efficiency**: ARM64 Lambda, On-Demand DynamoDB, minimal bundle size

**S3 integration is the natural next step**, with clear insertion points in:
1. Infrastructure (bucket, IAM, Terraform)
2. Application (new service, repository methods, API routes)
3. Data Model (DynamoDB RECEIPT items)
4. Testing (S3 mocking, integration tests)

The codebase is ready for extension with file upload capabilities following the same architectural patterns already in place.
