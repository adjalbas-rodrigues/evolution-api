#!/usr/bin/env bash
# Smoke test for HMAC validation of /webhook/meta
#
# Usage:
#   APP_SECRET=<secret> VERIFY_TOKEN=<token> EVOLUTION_URL=http://localhost:8080 ./scripts/test-meta-webhook.sh
#
# Exit codes: 0 = all OK, 1 = failure in any scenario
set -euo pipefail

APP_SECRET="${APP_SECRET:?need APP_SECRET env}"
VERIFY_TOKEN="${VERIFY_TOKEN:?need VERIFY_TOKEN env}"
EVOLUTION_URL="${EVOLUTION_URL:?need EVOLUTION_URL env (e.g. http://localhost:8080)}"

PAYLOAD='{"object":"whatsapp_business_account","entry":[{"id":"4399368417058320","changes":[]}]}'
EXPECTED_SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$APP_SECRET" -hex | sed 's/^.* //')"

pass=0; fail=0
check() {
  local desc="$1"; local expected_code="$2"; local actual_code="$3"
  if [[ "$actual_code" == "$expected_code" ]]; then
    echo "PASS: $desc (got $actual_code)"; pass=$((pass+1))
  else
    echo "FAIL: $desc (expected $expected_code, got $actual_code)"; fail=$((fail+1))
  fi
}

# GET handshake — correct token
code=$(curl -s -o /dev/null -w "%{http_code}" \
  "${EVOLUTION_URL}/webhook/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ABC")
check "GET handshake correct token" 200 "$code"

# GET handshake — wrong token
code=$(curl -s -o /dev/null -w "%{http_code}" \
  "${EVOLUTION_URL}/webhook/meta?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=ABC")
check "GET handshake wrong token" 403 "$code"

# POST — valid signature
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: ${EXPECTED_SIG}" \
  --data "$PAYLOAD" \
  "${EVOLUTION_URL}/webhook/meta")
check "POST valid signature" 200 "$code"

# POST — invalid signature
WRONG_SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "WRONG_SECRET" -hex | sed 's/^.* //')"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: ${WRONG_SIG}" \
  --data "$PAYLOAD" \
  "${EVOLUTION_URL}/webhook/meta")
check "POST invalid signature" 401 "$code"

# POST — no header
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" \
  "${EVOLUTION_URL}/webhook/meta")
check "POST no X-Hub-Signature-256 header" 401 "$code"

# POST — malformed header
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: deadbeef" \
  --data "$PAYLOAD" \
  "${EVOLUTION_URL}/webhook/meta")
check "POST malformed header" 401 "$code"

echo
echo "=== Result: ${pass} pass, ${fail} fail ==="
[[ $fail -eq 0 ]]
