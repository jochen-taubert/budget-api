import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeS3 } from './fake-s3.ts';
import { createUploadHandler } from '../src/upload.ts';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

describe('Upload-Handler', () => {
  it('sollte ein Dokument erfolgreich hochladen', async () => {
    const storage = new FakeS3();
    const handler = createUploadHandler({ storage });

    const content = Buffer.from('Test PDF content');
    const base64Content = content.toString('base64');

    const event: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {
      body: base64Content,
      isBase64Encoded: true,
      queryStringParameters: {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
      },
      headers: {},
      requestContext: {} as any,
    };

    const result = await handler(
      'tenant-1',
      'emp-1',
      'exp-123',
      event as APIGatewayProxyEventV2WithJWTAuthorizer,
    );

    assert.equal(result.fileName, 'receipt.pdf');
    assert.equal(result.contentType, 'application/pdf');
    assert.equal(result.sizeBytes, content.length);
    assert.ok(result.documentId);
    assert.ok(result.uploadedAt);
    assert.equal(storage.size(), 1);
  });

  it('sollte einen Fehler werfen, wenn fileName fehlt', async () => {
    const storage = new FakeS3();
    const handler = createUploadHandler({ storage });

    const event: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {
      body: Buffer.from('test').toString('base64'),
      isBase64Encoded: true,
      queryStringParameters: {
        contentType: 'application/pdf',
      },
      headers: {},
      requestContext: {} as any,
    };

    await assert.rejects(
      async () =>
        handler('tenant-1', 'emp-1', 'exp-123', event as APIGatewayProxyEventV2WithJWTAuthorizer),
      /fileName und contentType müssen als Query-Parameter übergeben werden/,
    );
  });

  it('sollte einen Fehler werfen, wenn Body nicht Base64-kodiert ist', async () => {
    const storage = new FakeS3();
    const handler = createUploadHandler({ storage });

    const event: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {
      body: 'plain text',
      isBase64Encoded: false,
      queryStringParameters: {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
      },
      headers: {},
      requestContext: {} as any,
    };

    await assert.rejects(
      async () =>
        handler('tenant-1', 'emp-1', 'exp-123', event as APIGatewayProxyEventV2WithJWTAuthorizer),
      /Body muss Base64-kodiert sein/,
    );
  });

  it('sollte einen Fehler werfen bei ungültigem Content-Type', async () => {
    const storage = new FakeS3();
    const handler = createUploadHandler({ storage });

    const event: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {
      body: Buffer.from('test').toString('base64'),
      isBase64Encoded: true,
      queryStringParameters: {
        fileName: 'malware.exe',
        contentType: 'application/x-msdownload',
      },
      headers: {},
      requestContext: {} as any,
    };

    await assert.rejects(
      async () =>
        handler('tenant-1', 'emp-1', 'exp-123', event as APIGatewayProxyEventV2WithJWTAuthorizer),
      /contentType muss eine von/,
    );
  });

  it('sollte einen Fehler werfen bei zu großer Datei', async () => {
    const storage = new FakeS3();
    const handler = createUploadHandler({ storage });

    // 6 MB Datei (Limit ist 5 MB)
    const largeContent = Buffer.alloc(6 * 1024 * 1024);

    const event: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {
      body: largeContent.toString('base64'),
      isBase64Encoded: true,
      queryStringParameters: {
        fileName: 'large.pdf',
        contentType: 'application/pdf',
      },
      headers: {},
      requestContext: {} as any,
    };

    await assert.rejects(
      async () =>
        handler('tenant-1', 'emp-1', 'exp-123', event as APIGatewayProxyEventV2WithJWTAuthorizer),
      /Datei darf maximal 5 MB groß sein/,
    );
  });

  it('sollte verschiedene erlaubte Content-Types akzeptieren', async () => {
    const storage = new FakeS3();
    const handler = createUploadHandler({ storage });

    const contentTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

    for (const contentType of contentTypes) {
      const content = Buffer.from(`Test ${contentType} content`);

      const event: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {
        body: content.toString('base64'),
        isBase64Encoded: true,
        queryStringParameters: {
          fileName: `test.${contentType.split('/')[1]}`,
          contentType,
        },
        headers: {},
        requestContext: {} as any,
      };

      const result = await handler(
        'tenant-1',
        'emp-1',
        'exp-123',
        event as APIGatewayProxyEventV2WithJWTAuthorizer,
      );

      assert.equal(result.contentType, contentType);
    }

    assert.equal(storage.size(), contentTypes.length);
  });
});
