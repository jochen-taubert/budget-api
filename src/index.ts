// Lambda-Einstiegspunkt. esbuild bündelt diese Datei nach dist/index.mjs (Handler: index.handler).
// Das AWS SDK v3 ist in der nodejs22.x-Runtime enthalten und bleibt außerhalb des Bundles.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHandler, type AuthMode } from './app.ts';
import { createRepository } from './repository.ts';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('Umgebungsvariable TABLE_NAME fehlt');

const authMode = (process.env.AUTH_MODE ?? 'none') as AuthMode;
if (authMode !== 'none' && authMode !== 'jwt') throw new Error(`Unbekannter AUTH_MODE: ${authMode}`);

// Außerhalb des Handlers erzeugt: wird über warme Aufrufe hinweg wiederverwendet.
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const handler = createHandler({ repo: createRepository({ db, tableName }), authMode });
