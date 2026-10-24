// Upload-Handler für Dokumenten-Uploads an Expenses
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { assertId, validationError, type DocumentReference } from './domain.ts';
import type { DocumentStorage } from './s3-adapter.ts';

export interface UploadHandlerOptions {
  storage: DocumentStorage;
}

/**
 * Parst multipart/form-data aus dem Event-Body.
 * Vereinfachte Implementierung für Base64-kodierte Binärdaten.
 */
function parseMultipartUpload(event: APIGatewayProxyEventV2WithJWTAuthorizer): {
  fileName: string;
  contentType: string;
  content: Buffer;
} {
  const contentType = event.headers?.['content-type'] || '';

  // Für die erste Implementierung erwarten wir Base64-kodierte Binärdaten im Body
  // mit fileName und contentType als Query-Parameter
  if (!event.isBase64Encoded) {
    throw validationError('Body muss Base64-kodiert sein');
  }

  const fileName = event.queryStringParameters?.fileName;
  const fileContentType = event.queryStringParameters?.contentType;

  if (!fileName || !fileContentType) {
    throw validationError('fileName und contentType müssen als Query-Parameter übergeben werden');
  }

  const content = Buffer.from(event.body || '', 'base64');

  return {
    fileName,
    contentType: fileContentType,
    content,
  };
}

/**
 * Erstellt einen Upload-Handler für Dokumente.
 * Route: POST /employees/{employeeId}/expenses/{expenseId}/documents
 */
export function createUploadHandler(options: UploadHandlerOptions) {
  return async function uploadDocument(
    tenant: string,
    employeeId: string,
    expenseId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<DocumentReference> {
    const { fileName, contentType, content } = parseMultipartUpload(event);

    const metadata = await options.storage.uploadDocument(tenant, employeeId, expenseId, {
      fileName,
      contentType,
      content,
    });

    return metadata;
  };
}
