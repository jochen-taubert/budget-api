// In-Memory S3 Mock für Unit-Tests – folgt dem Muster von fake-dynamo.ts
import type { DocumentStorage, UploadInput, DocumentMetadata } from '../src/s3-adapter.ts';
import { validationError } from '../src/domain.ts';

interface StoredDocument {
  tenant: string;
  employee: string;
  expenseId: string;
  metadata: DocumentMetadata;
  content: Buffer;
}

// Erlaubte Content-Types für Dokumente (muss mit s3-adapter.ts übereinstimmen)
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

export class FakeS3 implements DocumentStorage {
  private documents = new Map<string, StoredDocument>();

  async uploadDocument(
    tenant: string,
    employee: string,
    expenseId: string,
    input: UploadInput,
  ): Promise<DocumentMetadata> {
    // Validierung (muss mit s3-adapter.ts übereinstimmen)
    assertFileName(input.fileName);
    assertContentType(input.contentType);
    assertFileSize(input.content.length);

    const documentId = `doc-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const metadata: DocumentMetadata = {
      documentId,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.content.length,
      uploadedAt: new Date().toISOString(),
    };

    const key = this.buildKey(tenant, employee, expenseId, documentId);

    this.documents.set(key, {
      tenant,
      employee,
      expenseId,
      metadata,
      content: input.content,
    });

    return metadata;
  }

  async getDocument(tenant: string, employee: string, documentId: string): Promise<Buffer> {
    // Suche nach dem Dokument über alle Expenses
    for (const [key, doc] of this.documents.entries()) {
      if (doc.tenant === tenant && doc.employee === employee && doc.metadata.documentId === documentId) {
        return doc.content;
      }
    }
    throw validationError(`Dokument ${documentId} nicht gefunden`);
  }

  async deleteDocument(tenant: string, employee: string, documentId: string): Promise<void> {
    let deleted = false;
    for (const [key, doc] of this.documents.entries()) {
      if (doc.tenant === tenant && doc.employee === employee && doc.metadata.documentId === documentId) {
        this.documents.delete(key);
        deleted = true;
        break;
      }
    }
    if (!deleted) {
      throw validationError(`Dokument ${documentId} nicht gefunden`);
    }
  }

  // Test-Helper: alle Dokumente zurücksetzen
  reset(): void {
    this.documents.clear();
  }

  // Test-Helper: Anzahl gespeicherter Dokumente
  size(): number {
    return this.documents.size;
  }

  // Test-Helper: Dokument direkt abrufen
  getDocumentByKey(key: string): StoredDocument | undefined {
    return this.documents.get(key);
  }

  private buildKey(tenant: string, employee: string, expenseId: string, documentId: string): string {
    return `tenant/${tenant}/employee/${employee}/expense/${expenseId}/documents/${documentId}`;
  }
}
