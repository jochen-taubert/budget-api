# S3 Integration Guide for Mobility Budget API

## Overview
This guide outlines where and how to integrate S3 file upload functionality into the mobility-budget-api project following its existing clean architecture patterns.

---

## Current State
The README.md explicitly lists **Belege-Upload** (receipt/document upload) as "**Bewusst weggelassen**" (intentionally omitted). This is documented as "the next logical step" after the current core functionality.

**Current S3 Usage:** None

---

## Proposed Architecture

### 1. New S3 Integration Components

#### A. S3 Adapter (`src/s3-adapter.ts`)
**Purpose:** Encapsulate all S3 client interaction, following the Ports & Adapters pattern

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface UploadService {
  generatePresignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  recordUploadMetadata(tenant: string, employee: string, expenseId: string, fileKey: string, fileSize: number, contentType: string): Promise<void>;
  getUploadUrl(tenant: string, employee: string, expenseId: string): Promise<string | null>;
  deleteUpload(tenant: string, employee: string, expenseId: string): Promise<void>;
}

export function createS3Adapter({ s3, bucketName, repo }: {
  s3: S3Client;
  bucketName: string;
  repo: BudgetRepository;  // For storing metadata
}): UploadService {
  // Implementation
}
```

#### B. Domain Extensions (`src/domain.ts`)

Add new types and validation:
```typescript
export interface UploadMetadata {
  expenseId: string;
  fileKey: string;
  uploadedAt: string;
  fileSize: number;
  contentType: string;
}

export interface PresignedUploadUrl {
  uploadUrl: string;
  fields?: Record<string, string>;  // For POST uploads
  expiresAt: string;
}

export type UploadErrorCode =
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_EXPIRED'
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE';

// Validation
const VALID_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;  // 10 MB

export function assertContentType(mimeType: string): string {
  if (!VALID_MIME_TYPES.includes(mimeType)) {
    throw validationError(`Invalid file type: ${mimeType}`);
  }
  return mimeType;
}

export function assertFileSize(sizeBytes: number): number {
  if (sizeBytes > MAX_FILE_SIZE) {
    throw validationError(`File too large: ${sizeBytes} bytes (max ${MAX_FILE_SIZE})`);
  }
  return sizeBytes;
}
```

#### C. Repository Extension (`src/repository.ts`)

Add to `BudgetRepository` interface:
```typescript
export interface BudgetRepository {
  // ... existing methods
  
  // New upload-related methods
  recordUploadMetadata(
    tenant: string,
    employee: string,
    expenseId: string,
    metadata: UploadMetadata
  ): Promise<void>;
  
  getUploadMetadata(
    tenant: string,
    employee: string,
    expenseId: string
  ): Promise<UploadMetadata | undefined>;
  
  deleteUploadMetadata(
    tenant: string,
    employee: string,
    expenseId: string
  ): Promise<void>;
}
```

Implement in DynamoDB adapter:
```typescript
// Single-table design extension
// PK: T#<tenant>#E#<employee>
// SK: RECEIPT#<expenseId>  → {fileKey, uploadedAt, fileSize, contentType}

async recordUploadMetadata(tenant, employee, expenseId, metadata) {
  await db.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `T#${tenant}#E#${employee}`,
      sk: `RECEIPT#${expenseId}`,
      ...metadata,
      type: 'RECEIPT'
    }
  }));
}
```

#### D. API Routes Extension (`src/app.ts`)

Add new routes:
```typescript
'POST /employees/{employeeId}/expenses/{expenseId}/receipt-upload-url': async (event, caller) => {
  // Generate and return presigned upload URL
},

'GET /employees/{employeeId}/expenses/{expenseId}/receipt': async (event, caller) => {
  // Get receipt metadata and/or download URL
},

'DELETE /employees/{employeeId}/expenses/{expenseId}/receipt': async (event, caller) => {
  // Delete receipt from S3 and metadata from DynamoDB
}
```

#### E. Lambda Entry Point Update (`src/index.ts`)

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Adapter } from './s3-adapter.ts';

const s3BucketName = process.env.S3_BUCKET_NAME;
if (!s3BucketName) throw new Error('Environment variable S3_BUCKET_NAME is required');

const s3 = new S3Client({});
const uploadService = createS3Adapter({ s3, bucketName: s3BucketName, repo });

export const handler = createHandler({
  repo: createRepository({ db, tableName }),
  uploadService,  // Pass to handler
  authMode
});
```

---

### 2. Infrastructure Changes

#### A. S3 Bucket (`infra/main.tf`)

```hcl
# S3 bucket for receipts/documents
resource "aws_s3_bucket" "receipts" {
  bucket = "${local.name}-receipts"
  # Deletion protection should be enabled in production
}

# Block public access
resource "aws_s3_bucket_public_access_block" "receipts" {
  bucket                  = aws_s3_bucket.receipts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning for disaster recovery
resource "aws_s3_bucket_versioning" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CORS for web uploads
resource "aws_s3_bucket_cors_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["POST", "PUT", "GET"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# Lifecycle: transition to Glacier after 90 days for cost optimization
resource "aws_s3_bucket_lifecycle_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    id     = "archive-old-receipts"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 2555  # 7 years for compliance
    }
  }
}

# Access logging
resource "aws_s3_bucket_logging" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-receipts/"
}

# Bucket policy: only Lambda can write, presigned URLs for client uploads
resource "aws_s3_bucket_policy" "receipts" {
  bucket = aws_s3_bucket.receipts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowLambdaWrite"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.lambda.arn
        }
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.receipts.arn}/*"
      }
    ]
  })
}
```

#### B. Lambda IAM Policy Extension

Update `infra/main.tf` Lambda IAM policy:

```hcl
data "aws_iam_policy_document" "lambda_access" {
  # ... existing statements ...

  statement {
    sid       = "S3Receipts"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.receipts.arn}/*"]
  }

  statement {
    sid       = "S3ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.receipts.arn]
  }
}
```

#### C. Environment Variables

Update Lambda environment in `infra/main.tf`:

```hcl
environment {
  variables = {
    TABLE_NAME       = aws_dynamodb_table.budgets.name
    AUTH_MODE        = var.auth_mode
    S3_BUCKET_NAME   = aws_s3_bucket.receipts.id
    S3_URL_EXPIRY    = 900  # 15 minutes in seconds
    NODE_OPTIONS     = "--enable-source-maps"
  }
}
```

#### D. Terraform Variables

Add to `infra/variables.tf`:

```hcl
variable "s3_lifecycle_transition_days" {
  description = "Days before transitioning to Glacier (cost optimization)"
  type        = number
  default     = 90
}

variable "s3_lifecycle_expiration_days" {
  description = "Days before deleting old receipts (compliance retention)"
  type        = number
  default     = 2555  # 7 years
}

variable "max_file_size_mb" {
  description = "Maximum upload file size in MB"
  type        = number
  default     = 10
}
```

#### E. Outputs

Add to `infra/outputs.tf`:

```hcl
output "s3_bucket_name" {
  description = "S3 bucket for receipts"
  value       = aws_s3_bucket.receipts.id
}

output "s3_bucket_arn" {
  description = "ARN of S3 bucket for receipts"
  value       = aws_s3_bucket.receipts.arn
}
```

---

### 3. Testing Updates

#### A. Fake S3 (`test/fake-s3.ts`)

Create in-memory S3 mock following same pattern as `fake-dynamo.ts`:

```typescript
export interface FakeS3File {
  key: string;
  content: Buffer;
  contentType: string;
  uploadedAt: Date;
}

export function createFakeS3({ bucketName = 'test-bucket' } = {}) {
  const files = new Map<string, FakeS3File>();
  const sent: SentCommand[] = [];

  return {
    files,
    sent,
    send: async (command: unknown) => {
      const cmd = command as any;
      sent.push({ name: cmd.constructor.name, input: cmd });
      
      if (cmd.constructor.name === 'PutObjectCommand') {
        // Simulate S3 PutObject
        files.set(cmd.input.Key, {
          key: cmd.input.Key,
          content: cmd.input.Body,
          contentType: cmd.input.ContentType,
          uploadedAt: new Date()
        });
        return { ETag: '"' + randomUUID() + '"' };
      }
      // ... other commands ...
    }
  };
}
```

#### B. Test Cases

Add to `test/api.test.ts`:

```typescript
test('File upload: generate presigned URL and upload', async () => {
  const { call } = setup();
  const path = { employeeId: 'emp-1' };
  
  // Create expense first
  await call(PUT_BUDGET, { 
    path: { employeeId: 'emp-1', month: '2026-10' }, 
    body: { limitCents: 13500 } 
  });
  const expense = await call(POST_EXPENSE, { 
    path, 
    body: { month: '2026-10', amountCents: 100, category: 'OEPNV', description: 'Test' } 
  });
  
  // Request upload URL
  const uploadUrlRes = await call(POST_RECEIPT_URL, {
    path: { employeeId: 'emp-1', expenseId: expense.body.id },
    body: { contentType: 'application/pdf', fileSize: 5000 }
  });
  assert.equal(uploadUrlRes.status, 200);
  assert.ok(uploadUrlRes.body.uploadUrl);
});

test('File upload: prevent access to other employees receipts', async () => {
  // Verify row-level access control works for uploads too
});

test('File upload: validate file size and type', async () => {
  // Verify validation in domain layer
});
```

---

### 4. Integration Checklist

#### Phase 1: Foundation (Week 1)
- [ ] Create `src/s3-adapter.ts` (S3 client wrapper)
- [ ] Create `src/upload.ts` (upload service logic)
- [ ] Extend `src/domain.ts` with upload types
- [ ] Add S3 IAM to `infra/main.tf`
- [ ] Create `test/fake-s3.ts` (test mock)

#### Phase 2: API & Repository (Week 1-2)
- [ ] Extend `BudgetRepository` interface in `src/domain.ts`
- [ ] Implement upload methods in `src/repository.ts` (DynamoDB)
- [ ] Update Lambda entry point `src/index.ts`
- [ ] Add API routes in `src/app.ts`

#### Phase 3: Infrastructure (Week 2)
- [ ] Create S3 bucket resource in `infra/main.tf`
- [ ] Configure bucket policies (encryption, versioning, CORS)
- [ ] Add lifecycle rules for cost optimization
- [ ] Update Lambda IAM policy
- [ ] Add environment variables and outputs

#### Phase 4: Testing (Week 2)
- [ ] Add unit tests for upload service
- [ ] Test authorization (row-level access control)
- [ ] Test validation (file size, type)
- [ ] Test idempotency for uploads
- [ ] Add integration tests

#### Phase 5: Documentation & Deployment (Week 3)
- [ ] Update README.md with upload endpoints
- [ ] Document presigned URL flow
- [ ] Update Terraform documentation
- [ ] Add smoke tests for upload flow
- [ ] Deploy and verify

---

## API Endpoints

### Generate Presigned Upload URL
```
POST /employees/{employeeId}/expenses/{expenseId}/receipt-upload-url

Request:
{
  "contentType": "application/pdf",
  "fileSize": 245000
}

Response (200):
{
  "uploadUrl": "https://bucket.s3.amazonaws.com/...",
  "expiresAt": "2026-10-23T09:30:00Z",
  "fields": {
    "bucket": "...",
    "key": "...",
    "acl": "private",
    "policy": "...",
    "signature": "..."
  }
}
```

### Get Receipt Information
```
GET /employees/{employeeId}/expenses/{expenseId}/receipt

Response (200):
{
  "expenseId": "uuid",
  "fileKey": "s3://bucket/path/file.pdf",
  "uploadedAt": "2026-10-23T09:15:00Z",
  "fileSize": 245000,
  "contentType": "application/pdf",
  "downloadUrl": "https://..."  // Presigned GET URL
}

Response (404):
{
  "code": "UPLOAD_NOT_FOUND",
  "message": "No receipt found for this expense"
}
```

### Delete Receipt
```
DELETE /employees/{employeeId}/expenses/{expenseId}/receipt

Response (204): No Content
```

---

## Security Considerations

1. **Least Privilege S3 Access:** Lambda can only read/write receipts, no other S3 operations
2. **Presigned URLs:** 15-minute expiration for upload URLs
3. **Row-Level Access Control:** Non-admins can only upload for their own expenses
4. **File Validation:** Strict MIME type and size validation in domain layer
5. **Encryption:** All files encrypted at rest (S3 default), in transit (HTTPS)
6. **Audit Trail:** S3 access logging, DynamoDB TTL for old metadata
7. **Data Retention:** Lifecycle policies for long-term storage (Glacier)

---

## Cost Implications

Typical monthly costs for small-to-medium usage:
- S3 Storage: ~$0.02-0.10 per GB
- S3 Requests (PUT/GET): ~$0.0004 per 10k requests
- Glacier (if archival enabled): ~$0.004 per GB

Example: 1000 PDF files (5MB average) per month:
- S3 Standard: ~$0.25/month
- After 3 months on Glacier: ~$0.02/month per file

---

## Monitoring & Observability

Add CloudWatch metrics:
```hcl
# S3 access metrics in Lambda logs
log.info(JSON.stringify({
  level: 'info',
  requestId,
  event: 'file_uploaded',
  expenseId,
  fileSize,
  contentType,
  duration: endTime - startTime
}));
```

CloudWatch Insights queries:
```
fields @timestamp, fileSize, contentType | stats sum(fileSize) by contentType
fields @timestamp, event | filter event like /upload|delete/ | stats count() by event
```

---

## Migration Path

For existing deployments:
1. Deploy new infrastructure (S3 bucket) with zero-downtime
2. New expenses automatically support receipt uploads
3. Existing expenses can be retroactively enhanced with receipts
4. No changes required to existing expense data model

---

## Related Features (Future)

Once S3 integration is complete, consider:
- **OCR Processing:** Extract text from receipts for validation
- **Virus Scanning:** ClamAV integration for uploaded files
- **Archive Strategy:** Automatic archival to Glacier after 1 year
- **Export:** Include receipts in monthly export/report
- **Mobile Upload:** Implement mobile app upload UI
- **Batch Upload:** Drag-and-drop multiple receipts for one expense

---

## References

- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3)
- [Presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [S3 Security Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security.html)

