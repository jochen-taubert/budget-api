#!/usr/bin/env bash
# End-to-End-Test gegen die deployte API (auth_mode = "none").
# Aufruf: ./scripts/smoke.sh  (liest die URL aus terraform output)
set -euo pipefail

cd "$(dirname "$0")/../infra"
API="${API_URL:-$(terraform output -raw api_url)}"
API="${API%/}"
TENANT="smoke-$(date +%s)"
EMP="emp-1"
MONTH="$(date +%Y-%m)"
H=(-H "content-type: application/json" -H "x-tenant-id: ${TENANT}")

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
call() { curl -sS -w '\n→ HTTP %{http_code}\n' "$@"; }

step "1. Budget 135,00 EUR für ${MONTH} setzen"
call -X PUT "${H[@]}" -d '{"limitCents":13500}' "${API}/employees/${EMP}/budgets/${MONTH}"

step "2. Deutschlandticket buchen (mit Idempotency-Key)"
call -X POST "${H[@]}" -H "idempotency-key: beleg-1" \
  -d "{\"month\":\"${MONTH}\",\"amountCents\":5800,\"category\":\"OEPNV\",\"description\":\"Deutschlandticket\"}" \
  "${API}/employees/${EMP}/expenses"

step "3. Gleicher Request noch einmal → 200 statt 201, keine Doppelbuchung"
call -X POST "${H[@]}" -H "idempotency-key: beleg-1" \
  -d "{\"month\":\"${MONTH}\",\"amountCents\":5800,\"category\":\"OEPNV\",\"description\":\"Deutschlandticket\"}" \
  "${API}/employees/${EMP}/expenses"

step "4. Zu teure Buchung → 409 INSUFFICIENT_BUDGET"
call -X POST "${H[@]}" \
  -d "{\"month\":\"${MONTH}\",\"amountCents\":99999,\"category\":\"FAHRRAD\",\"description\":\"Neues Rad\"}" \
  "${API}/employees/${EMP}/expenses"

step "5. Monatsansicht"
call "${H[@]}" "${API}/employees/${EMP}/budgets/${MONTH}"

step "6. Anderer Mandant sieht nichts → 404"
call -H "x-tenant-id: fremd" "${API}/employees/${EMP}/budgets/${MONTH}"
