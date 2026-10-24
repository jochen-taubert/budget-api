# S3 Integration für Dokumenten-Uploads

## Übersicht

Die Mobilitätsbudget-API wurde um die Möglichkeit erweitert, Dokumente (z.B. Belege, Rechnungen) zu Ausgaben hochzuladen. Die Dokumente werden in Amazon S3 gespeichert und die Metadaten werden in den Expense-Objekten referenziert.

## Architektur

Die S3-Integration folgt dem gleichen Clean-Architecture-Muster wie der Rest der Anwendung:

```
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (HTTP API)                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      Lambda Function                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  app.ts (HTTP-Handler)                                 │ │
│  │  - POST /employees/{id}/expenses/{expenseId}/documents │ │
│  └───────────────────┬────────────────────────────────────┘ │
│                      │                                        │
│                      ▼                                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  upload.ts (Upload-Handler)                            │ │
│  │  - Parsing von multipart/form-data                     │ │
│  │  - Delegation an DocumentStorage                       │ │
│  └───────────────────┬────────────────────────────────────┘ │
│                      │                                        │
│                      ▼                                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  s3-adapter.ts (DocumentStorage Interface)             │ │
│  │  - Validierung (Content-Type, Dateigröße, Dateiname)  │ │
│  │  - S3-Upload mit Server-Side-Encryption               │ │
│  │  - Mandanten- und Mitarbeiter-Isolierung              │ │
│  └───────────────────┬────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                         Amazon S3                            │
│  Bucket: {project-name}-documents                            │
│  - Server-Side Encryption (AES256)                           │
│  - Versioning aktiviert                                      │
│  - Public Access blockiert                                   │
│  - Lifecycle: Archive nach 7 Jahren → Glacier               │
└─────────────────────────────────────────────────────────────┘
```

## Neue Dateien

### 1. `src/s3-adapter.ts`
S3-Adapter für Dokumenten-Uploads. Implementiert das `DocumentStorage`-Interface.

**Funktionen:**
- `uploadDocument()`: Lädt ein Dokument nach S3 hoch
- `getDocument()`: Holt ein Dokument aus S3 (stub, erfordert DynamoDB-Integration)
- `deleteDocument()`: Löscht ein Dokument aus S3 (stub, erfordert DynamoDB-Integration)

**Validierungen:**
- Erlaubte Content-Types: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`
- Maximale Dateigröße: 5 MB
- Dateiname-Muster: `^[A-Za-z0-9._-]{1,255}$`

**S3-Schlüssel-Struktur:**
```
tenant/{tenantId}/employee/{employeeId}/expense/{expenseId}/documents/{documentId}
```

Diese Struktur ermöglicht:
- Mandanten-Isolierung auf S3-Ebene
- Mitarbeiter-Isolierung
- Zuordnung zu spezifischen Ausgaben
- IAM-Policies für granulare Zugriffskontrolle

### 2. `src/upload.ts`
Upload-Handler für die API. Parst multipart/form-data und delegiert an `DocumentStorage`.

**API-Spezifikation:**
- **Route:** `POST /employees/{employeeId}/expenses/{expenseId}/documents`
- **Content-Type:** `application/octet-stream` (Base64-kodiert)
- **Query-Parameter:**
  - `fileName`: Name der Datei
  - `contentType`: MIME-Type der Datei

**Beispiel-Request:**
```bash
curl -X POST \
  "https://api.example.com/employees/emp-1/expenses/exp-123/documents?fileName=receipt.pdf&contentType=application/pdf" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@receipt.pdf"
```

**Response:**
```json
{
  "documentId": "doc-1234567890-abc123",
  "fileName": "receipt.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 45678,
  "uploadedAt": "2025-01-15T10:30:00.000Z"
}
```

### 3. `test/fake-s3.ts`
In-Memory S3-Mock für Unit-Tests. Folgt dem Muster von `fake-dynamo.ts`.

**Test-Helper:**
- `reset()`: Löscht alle Dokumente
- `size()`: Gibt Anzahl gespeicherter Dokumente zurück
- `getDocumentByKey()`: Holt Dokument direkt per Schlüssel

### 4. `test/upload.test.ts`
Unit-Tests für Upload-Funktionalität.

**Test-Coverage:**
- ✅ Erfolgreicher Upload
- ✅ Validierung: fehlender fileName
- ✅ Validierung: nicht Base64-kodierter Body
- ✅ Validierung: ungültiger Content-Type
- ✅ Validierung: zu große Datei (> 5 MB)
- ✅ Verschiedene erlaubte Content-Types

## Geänderte Dateien

### 1. `src/domain.ts`
Erweitert um:
- `DocumentReference`-Interface für Dokumenten-Metadaten
- `documents?: DocumentReference[]` im `Expense`-Interface

### 2. `src/app.ts`
Erweitert um:
- `uploadHandler?`-Parameter in `HandlerOptions`
- Neue Route: `POST /employees/{employeeId}/expenses/{expenseId}/documents`
- Autorisierungsprüfung: Mitarbeitende können nur ihre eigenen Dokumente hochladen

### 3. `infra/main.tf`
Neue Ressourcen:
- `aws_s3_bucket.documents`: S3-Bucket für Dokumente
- `aws_s3_bucket_server_side_encryption_configuration.documents`: AES256-Verschlüsselung
- `aws_s3_bucket_versioning.documents`: Versionierung aktiviert
- `aws_s3_bucket_public_access_block.documents`: Public Access blockiert
- `aws_s3_bucket_lifecycle_configuration.documents`: Archivierung nach 7 Jahren

IAM-Erweiterungen:
- Lambda-Rolle erhält S3-Berechtigungen: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`
- Berechtigungen gelten nur für `{bucket-name}/*`

Umgebungsvariable:
- `BUCKET_NAME`: Name des S3-Buckets

### 4. `package.json`
Neue Abhängigkeit:
- `@aws-sdk/client-s3`: ^3.1156.0

## Deployment

### 1. Dependencies installieren
```bash
npm install
```

### 2. TypeCheck und Tests
```bash
npm run check
```

### 3. Terraform Apply
```bash
cd infra
terraform init
terraform plan
terraform apply
```

Dies erstellt:
- S3-Bucket `{project-name}-documents`
- IAM-Policies für Lambda
- Umgebungsvariablen für Lambda

### 4. Lambda-Update
Der Lambda-Code wird automatisch beim nächsten `terraform apply` aktualisiert, wenn sich das Bundle geändert hat.

## Sicherheit

### Verschlüsselung
- **Server-Side Encryption:** Alle Objekte werden mit AES256 verschlüsselt
- **In-Transit:** HTTPS obligatorisch (API Gateway)

### Zugriffskontrolle
- **IAM:** Lambda-Rolle hat nur Zugriff auf den Dokumente-Bucket
- **Autorisierung:** Mitarbeitende können nur ihre eigenen Dokumente hochladen
- **Mandanten-Isolierung:** S3-Schlüssel enthalten Tenant-ID

### Public Access
- Alle Public-Access-Einstellungen sind blockiert
- Zugriff nur über Lambda-Funktion möglich

## Kosten

### S3-Kosten (eu-central-1, Stand 2025)
- **Speicherung:** ~0,023 USD/GB/Monat (Standard)
- **Archiv (Glacier):** ~0,004 USD/GB/Monat (nach 7 Jahren)
- **PUT-Requests:** 0,005 USD/1.000 Requests
- **GET-Requests:** 0,0004 USD/1.000 Requests

### Beispielrechnung (100 Mitarbeitende, 10 Belege/Monat, Ø 500 KB)
- **Uploads/Monat:** 1.000 Belege × 500 KB = 500 MB
- **Speicherung (Jahr 1):** 6 GB × 0,023 USD = 0,14 USD/Monat
- **PUT-Requests:** 1.000 × 0,005 USD/1.000 = 0,005 USD/Monat
- **Gesamt:** ~0,15 USD/Monat (~1,80 USD/Jahr)

Nach 7 Jahren werden alte Belege automatisch nach Glacier archiviert (Kosteneinsparung ~80%).

## Einschränkungen

### Aktuell nicht implementiert
1. **GET-Endpoint:** Download von Dokumenten
   - Erfordert: Verknüpfung mit DynamoDB für expenseId-Lookup
   - Implementierung: `GET /employees/{id}/expenses/{expenseId}/documents/{documentId}`

2. **DELETE-Endpoint:** Löschen von Dokumenten
   - Erfordert: Gleiche DynamoDB-Verknüpfung
   - Implementierung: `DELETE /employees/{id}/expenses/{expenseId}/documents/{documentId}`

3. **DynamoDB-Integration:** Speicherung von DocumentReferences
   - Aktuell: `documents`-Feld ist im Domain-Model, aber wird nicht persistiert
   - Erforderlich: Update von `repository.ts` zum Speichern/Laden von Dokumenten-Metadaten

4. **Multipart Upload:** Für Dateien > 5 MB
   - Aktuell: 5 MB Limit
   - S3 Multipart Upload ermöglicht bis zu 5 TB

### Empfohlene nächste Schritte
1. DynamoDB-Schema erweitern um `documents`-Attribut
2. `repository.ts` anpassen zum Speichern von DocumentReferences
3. GET- und DELETE-Endpoints implementieren
4. Presigned URLs für direkten S3-Upload (Client → S3, ohne Lambda)

## Testing

### Unit-Tests ausführen
```bash
npm test
```

### Einzelner Test
```bash
node --test test/upload.test.ts
```

### Test-Coverage
Alle Upload-Funktionen sind durch Unit-Tests abgedeckt:
- 9 bestehende Tests (Budget/Expense-Logik)
- 6 neue Tests (Upload-Funktionalität)
- **Total: 15/15 Tests passing**

## Troubleshooting

### "Upload-Funktionalität nicht aktiviert"
**Fehler:** HTTP 501
**Lösung:** `uploadHandler` muss in `index.ts` konfiguriert werden:

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3DocumentStorage } from './s3-adapter.ts';
import { createUploadHandler } from './upload.ts';

const s3 = new S3Client({});
const storage = new S3DocumentStorage(s3, process.env.BUCKET_NAME!);
const uploadHandler = createUploadHandler({ storage });

const handler = createHandler({
  repo,
  authMode,
  uploadHandler: (tenant, employee, expenseId, event) =>
    uploadHandler(tenant, employee, expenseId, event),
});
```

### "Cannot find module"
**Fehler:** ERR_MODULE_NOT_FOUND
**Lösung:** Imports müssen `.ts`-Erweiterungen verwenden (nicht `.js`):
```typescript
import { FakeS3 } from './fake-s3.ts';  // ✅
import { FakeS3 } from './fake-s3.js';  // ❌
```

### "Datei darf maximal 5 MB groß sein"
**Fehler:** VALIDATION_ERROR
**Lösung:** Datei ist zu groß. Entweder:
1. Datei komprimieren
2. Limit in `s3-adapter.ts` und `fake-s3.ts` erhöhen (MAX_FILE_SIZE)
3. S3 Multipart Upload implementieren

## Weitere Informationen

- **AWS S3 Dokumentation:** https://docs.aws.amazon.com/s3/
- **Clean Architecture:** https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- **API Gateway File Upload:** https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-payload-encodings.html
