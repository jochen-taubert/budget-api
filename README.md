# Mobilitätsbudget-API

Kleines, deploybares Serverless-Projekt: Arbeitgeber setzen pro Mitarbeiter:in und Monat ein Mobilitätsbudget, Mitarbeitende buchen Ausgaben (ÖPNV, Bahn, Fahrrad, Carsharing) dagegen. Gebaut mit **TypeScript** auf **AWS Lambda (Node.js 22)**, **DynamoDB** und **API Gateway (HTTP API)**, komplett per **Terraform** bereitgestellt, optional abgesichert über einen **JWT-Authorizer** (Keycloak, Cognito oder ein anderer OIDC-Provider).

```
Client ──► API Gateway ──(JWT prüfen)──► Lambda ──► DynamoDB
               │                            │
               └── Access-Logs              └── Logs (CloudWatch)
```

## API

| Methode | Pfad | Zweck | Scope (JWT-Modus) |
|---|---|---|---|
| `PUT` | `/employees/{employeeId}/budgets/{month}` | Budget setzen, Body `{"limitCents": 13500}` | `budget:admin` |
| `GET` | `/employees/{employeeId}/budgets/{month}` | Budget + Buchungen des Monats | `budget:read` |
| `POST` | `/employees/{employeeId}/expenses` | Ausgabe buchen, Body `{"month","amountCents","category","description"}`, optional Header `Idempotency-Key` | `expense:write` |

Beträge sind ganze Cent-Werte (keine Gleitkommazahlen bei Geld). `month` hat das Format `YYYY-MM`.

## Was das Projekt zeigt

**Single-Table-Design.** Eine Tabelle, ein Partition Key pro Mitarbeiter:in eines Mandanten:

| pk | sk | Inhalt |
|---|---|---|
| `T#acme#E#emp-1` | `BUDGET#2026-10` | Limit, verbraucht, verbleibend |
| `T#acme#E#emp-1` | `TX#2026-10#<zeit>#<id>` | einzelne Buchung, chronologisch sortiert |
| `T#acme#E#emp-1` | `IDEMP#<key>` | Idempotenz-Eintrag, läuft per TTL nach 7 Tagen aus |

Die Monatsansicht ist damit ein `GetItem` plus ein `Query` mit `begins_with(sk, "TX#2026-10#")`.

**Kein Überziehen, auch bei gleichzeitigen Requests.** Eine Buchung ist eine `TransactWriteItems`-Transaktion: Budget abbuchen mit der Bedingung `remainingCents >= :amt`, Buchung schreiben, Idempotenz-Key belegen. Entweder alles oder nichts. DynamoDB kann in Bedingungen nicht rechnen, deshalb wird `remainingCents` als eigenes Feld geführt.

**Idempotenz.** Schickt die App denselben Beleg wegen eines Netzwerkfehlers zweimal (gleicher `Idempotency-Key`), kommt die Originalbuchung mit `200` zurück, ohne doppelt abzubuchen. Wird derselbe Key mit anderen Daten verwendet, gibt es `422`.

**Mandantentrennung.** Im JWT-Modus kommt der Mandant ausschließlich aus dem Token-Claim `tenant`, nie aus einem Header. Mitarbeitende ohne `budget:admin` sehen nur Daten mit ihrer eigenen `employee_id`. IDs sind auf `[A-Za-z0-9_-]` beschränkt, damit niemand per `#` in fremde Schlüssel springt.

**Arbeitsteilung Gateway und Lambda.** Das API Gateway prüft Signatur, Ablauf, Issuer, Audience und Scopes, bevor die Lambda startet. Die Lambda prüft das Fachliche: Mandant, eigene Daten, Budgetregeln.

**Betrieb.** Least-Privilege-IAM (nur die genutzten DynamoDB-Aktionen auf genau diese Tabelle), Log-Gruppen mit Retention, strukturierte Fehler-Logs mit `requestId`, Access-Logs am Gateway, Throttling, Point-in-Time-Recovery für die Tabelle, ARM64-Lambda.

**Ports and Adapters im Kleinen.** `domain.ts` definiert Typen, Regeln und die Schnittstelle `BudgetRepository`. Die HTTP-Schicht kennt nur diese Schnittstelle, DynamoDB steckt allein in `repository.ts`. Request-Bodies kommen als `unknown` an und werden in `domain.ts` zu geprüften Typen (`ExpenseInput`, `Category` als Union-Typ).

## Projektstruktur

```
src/
  domain.ts         Typen, Validierung, fachliche Fehler, Repository-Schnittstelle (ohne AWS)
  repository.ts     DynamoDB-Adapter: Budget, Buchung (Transaktion), Idempotenz
  app.ts            HTTP-Routing, Autorisierung, Fehler → Statuscodes
  index.ts          Lambda-Einstieg, verdrahtet SDK und Repository
test/
  api.test.ts       9 Tests über Handler + Repository
  fake-dynamo.ts    In-Memory-Ersatz für DynamoDB
dist/               Build-Ergebnis (index.mjs + Source Map), wird nicht eingecheckt
infra/
  versions.tf  variables.tf  main.tf  api.tf  outputs.tf
  tests/config.tftest.hcl   Terraform-Tests mit gemocktem Provider
  backend.tf.example        Remote State in S3
  terraform.tfvars.example
scripts/smoke.sh            End-to-End gegen die deployte API
```

## Lokal entwickeln

Voraussetzung: Node.js ≥ 22.18. Ab dieser Version führt Node TypeScript-Dateien direkt aus, indem es die Typannotationen entfernt. Die Tests brauchen deshalb keinen Build-Schritt.

```bash
npm install
npm run typecheck   # tsc, prüft nur, erzeugt nichts
npm test            # node --test test/*.test.ts
npm run build       # esbuild → dist/index.mjs (ca. 13 KB, SDK bleibt draußen)
npm run check       # alles drei nacheinander
```

Arbeitsteilung: `tsc` prüft die Typen, `esbuild` bündelt für Lambda. Damit Node die Dateien direkt ausführen kann, nutzt der Code nur „löschbare“ TypeScript-Syntax (`erasableSyntaxOnly`: keine `enum`s, keine Parameter-Properties) und importiert mit `.ts`-Endung.

Die Tests laufen ohne AWS gegen einen In-Memory-Ersatz, der die Semantik der genutzten DynamoDB-Befehle nachbildet (Bedingungen, Transaktionsabbruch, Pagination). Ob die echten Expressions in DynamoDB greifen, zeigt erst `make smoke` nach dem Deployment.

Die Terraform-Konfiguration hat eigene Tests (`infra/tests/config.tftest.hcl`), die mit gemocktem AWS-Provider laufen, also ebenfalls ohne Credentials:

```bash
make tf-test     # baut dist/, dann: cd infra && terraform init && terraform test
```

Sie prüfen u. a., dass im JWT-Modus alle Routen geschützt sind, dass ein fehlender Issuer den Plan abbricht und dass die Tabelle TTL und Point-in-Time-Recovery hat.

## Deployen

Voraussetzungen: Terraform ≥ 1.7, AWS CLI mit gültigen Credentials (`aws sts get-caller-identity`).

```bash
npm install
cp infra/terraform.tfvars.example infra/terraform.tfvars   # bei Bedarf anpassen
make init
make apply      # baut zuerst dist/, dann terraform apply
make smoke
```

Terraform packt `dist/` per `archive_file` zur Lambda-Zip. Fehlt `dist/`, bricht der Plan ab; deshalb führen `make plan` und `make apply` vorher `npm run build` aus. Ändert sich der Code, ändert sich der Hash der Zip, und Terraform aktualisiert nur die Lambda.

Kosten: DynamoDB On-Demand, Lambda und HTTP API liegen bei ein paar Testaufrufen im Cent-Bereich bzw. im Free Tier. Aufräumen mit `make destroy`.

### Mit JWT-Authorizer (Keycloak)

In `terraform.tfvars`:

```hcl
auth_mode     = "jwt"
oidc_issuer   = "https://auth.example.de/realms/benefits"
oidc_audience = "benefits-api"
```

In Keycloak:

1. Client `benefits-api` anlegen (Client Credentials oder Authorization Code).
2. **Audience Mapper** hinzufügen, der `benefits-api` in `aud` schreibt. Ohne ihn steht dort oft nur `account`, und das Gateway lehnt jedes Token mit 401 ab.
3. Client Scopes `budget:read`, `budget:admin`, `expense:write` anlegen und zuweisen.
4. User Attribute `tenant` und `employee_id` per **User Attribute Mapper** ins Access Token übernehmen.
5. Der Realm muss aus dem Internet erreichbar sein, damit AWS die öffentlichen Schlüssel (JWKS) laden kann.

Mit Cognito ist der Issuer `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`; `tenant` und `employee_id` kommen dann über Custom Attributes bzw. einen Pre-Token-Generation-Trigger ins Token.

## Bewusst weggelassen

- **Belege-Upload** (S3 + presigned URL + Verarbeitung über SQS) – der nächste logische Schritt.
- **Steuerregeln pro Kategorie** (z. B. Sachbezugsgrenze) – gehören versioniert in eine eigene Regelkomponente.
- **Payroll-Export** zum Monatsabschluss.
- **CI/CD** – z. B. GitHub Actions mit OIDC-Rolle statt statischer AWS-Keys, `terraform plan` als PR-Kommentar.
