// S3-Adapter für Dokumenten-Uploads – folgt dem gleichen Muster wie repository.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { validationError } from './domain.ts';

export interface DocumentMetadata {
  documentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface UploadInput {
  fileName: string;
  contentType: string;
  content: Buffer;
}

export interface DocumentStorage {
  uploadDocument(
    tenant: string,
    employee: string,
    expenseId: string,
    input: UploadInput,
  ): Promise<DocumentMetadata>;
  getDocument(tenant: string, employee: string, documentId: string): Promise<Buffer>;
  deleteDocument(tenant: string, employee: string, documentId: string): Promise<void>;
}

// Erlaubte Content-Types für Dokumente
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

function assertFileName(fileName: string): void {
  if (!FILE_NAME_PATTERN.test(fileName)) {
    throw validationError('fileName ist ungültig (erlaubt: A-Z, a-z, 0-9, ., _, -, max. 255 Zeichen)');
  }
}

function assertContentType(contentType: string): void {
  if (!ALLOWED_CONTENT_TYPES.includes(contentType as any)) {
    throw validationError(`contentType muss eine von ${ALLOWED_CONTENT_TYPES.join(', ')} sein`);
  }
}

function assertFileSize(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_SIZE) {
    throw validationError(`Datei darf maximal ${MAX_FILE_SIZE / 1024 / 1024} MB groß sein`);
  }
}

function generateDocumentId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Erzeugt S3-Schlüssel mit Tenant- und Employee-Isolierung.
 * Format: tenant/{tenantId}/employee/{employeeId}/expense/{expenseId}/documents/{documentId}
 */
function buildS3Key(tenant: string, employee: string, expenseId: string, documentId: string): string {
  return `tenant/${tenant}/employee/${employee}/expense/${expenseId}/documents/${documentId}`;
}

export class S3DocumentStorage implements DocumentStorage {
  private readonly s3: S3Client;
  private readonly bucketName: string;

  constructor(s3: S3Client, bucketName: string) {
    this.s3 = s3;
    this.bucketName = bucketName;
  }

  async uploadDocument(
    tenant: string,
    employee: string,
    expenseId: string,
    input: UploadInput,
  ): Promise<DocumentMetadata> {
    assertFileName(input.fileName);
    assertContentType(input.contentType);
    assertFileSize(input.content.length);

    const documentId = generateDocumentId();
    const key = buildS3Key(tenant, employee, expenseId, documentId);

    const command: PutObjectCommandInput = {
      Bucket: this.bucketName,
      Key: key,
      Body: input.content,
      ContentType: input.contentType,
      Metadata: {
        tenant,
        employee,
        expenseId,
        fileName: input.fileName,
      },
      // Server-side encryption aktivieren
      ServerSideEncryption: 'AES256',
    };

    await this.s3.send(new PutObjectCommand(command));

    return {
      documentId,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.content.length,
      uploadedAt: new Date().toISOString(),
    };
  }

  async getDocument(tenant: string, employee: string, documentId: string): Promise<Buffer> {
    // Um das Dokument zu holen, müssen wir den vollständigen Schlüssel kennen.
    // In einer echten Implementierung würden wir die expenseId aus der DynamoDB holen.
    // Für diese Implementierung gehen wir davon aus, dass documentId den vollständigen Pfad enthält.
    const error: Error = new Error('getDocument: Implementierung erfordert Verknüpfung mit DynamoDB für expenseId-Lookup');
    throw error;
  }

  async deleteDocument(tenant: string, employee: string, documentId: string): Promise<void> {
    const error: Error = new Error('deleteDocument: Implementierung erfordert Verknüpfung mit DynamoDB für expenseId-Lookup');
    throw error;
  }
}
