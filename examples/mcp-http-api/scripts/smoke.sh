#!/usr/bin/env bash
# Smoke test for the deployed MCP endpoint (examples/mcp-http-api).
#
# Usage:
#   scripts/smoke.sh --token-file access.token [--noscope-token-file other.token]
#   scripts/smoke.sh --negative-only              # no token needed
#
# Inputs (flags override env):
#   --token-file FILE          access token WITH mcp/read, from the authorization-code flow
#   --noscope-token-file FILE  access token from the same client WITHOUT mcp/read (expects 403)
#   --url URL                  MCP endpoint (default: terraform output mcp_url)
#   --client-id ID             MCP app client id (default: terraform output mcp_app_client_id)
#   --negative-only            run only the checks that need no valid token
#
# Exit 0 = all checks passed; 1 = at least one failed.

set -uo pipefail

cd "$(dirname "$0")/.."

TOKEN_FILE="${SMOKE_TOKEN_FILE:-}"
NOSCOPE_TOKEN_FILE="${SMOKE_NOSCOPE_TOKEN_FILE:-}"
MCP_URL="${SMOKE_MCP_URL:-}"
CLIENT_ID="${SMOKE_CLIENT_ID:-}"
NEGATIVE_ONLY="${SMOKE_NEGATIVE_ONLY:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --noscope-token-file) NOSCOPE_TOKEN_FILE="$2"; shift 2 ;;
    --url) MCP_URL="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --negative-only) NEGATIVE_ONLY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MCP_URL" ]]; then
  MCP_URL="$(terraform output -raw mcp_url 2>/dev/null || true)"
fi
if [[ -z "$CLIENT_ID" ]]; then
  CLIENT_ID="$(terraform output -raw mcp_app_client_id 2>/dev/null || true)"
fi
if [[ -z "$MCP_URL" ]]; then
  echo "MCP URL unknown: pass --url or run from an applied example" >&2
  exit 2
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# POST a JSON-RPC body. Sets $STATUS, $BODY, $HEADERS (lower-cased).
# $1 = token ("" for none), $2 = raw body, $3 = optional HTTP method override
request() {
  local token="$1" body="$2" method="${3:-POST}"
  local tmp; tmp="$(mktemp)"
  local -a auth=()
  [[ -n "$token" ]] && auth=(-H "Authorization: Bearer $token")
  local raw
  raw="$(curl -sS -o "$tmp" -D "$tmp.h" -w '%{http_code}' -X "$method" "$MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    "${auth[@]}" --data-binary "$body" 2>"$tmp.err")" || raw="000"
  STATUS="$raw"
  BODY="$(cat "$tmp")"
  HEADERS="$(tr -d '\r' < "$tmp.h" | tr '[:upper:]' '[:lower:]')"
  if [[ "$raw" == "000" ]]; then BODY="curl: $(cat "$tmp.err")"; fi
  rm -f "$tmp" "$tmp.h" "$tmp.err"
}

# Read a field from JSON on stdin with a python expression over `d`.
jq_py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

# Decode a JWT payload (no verification; the edge does that) and print one claim.
claim() {
  python3 - "$1" "$2" <<'PY'
import base64, json, sys
tok, key = sys.argv[1], sys.argv[2]
p = tok.split('.')[1]
p += '=' * (-len(p) % 4)
print(json.loads(base64.urlsafe_b64decode(p)).get(key, ''))
PY
}

# Human-readable reason for a 401/403 on a token we can decode locally. The
# edge makes the decision; this only explains it.
token_problem() {
  python3 - "$1" <<'PY'
import base64, json, sys, time
tok = sys.argv[1]
try:
    p = tok.split('.')[1]
    p += '=' * (-len(p) % 4)
    exp = json.loads(base64.urlsafe_b64decode(p)).get('exp', 0)
except Exception:
    print('token is not a decodable JWT'); sys.exit(0)
if exp and exp < time.time():
    print(f'token expired {int(time.time() - exp)}s ago; fetch a fresh one')
PY
}

echo "Endpoint: $MCP_URL"
echo

# ── Unauthenticated / negative checks (no valid token needed) ────────────────

request "" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
if [[ "$STATUS" == "401" ]]; then pass "no token -> 401"; else fail "no token -> 401" "got $STATUS: $BODY"; fi

request "not.a.jwt" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
if [[ "$STATUS" == "401" ]]; then pass "malformed token -> 401"; else fail "malformed token -> 401" "got $STATUS: $BODY"; fi

request "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
if [[ "$STATUS" == "401" ]]; then pass "forged-signature token -> 401"; else fail "forged-signature token -> 401" "got $STATUS: $BODY"; fi

if [[ -n "$NOSCOPE_TOKEN_FILE" ]]; then
  NOSCOPE="$(tr -d '[:space:]' < "$NOSCOPE_TOKEN_FILE")"
  request "$NOSCOPE" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
  if [[ "$STATUS" == "403" && "$HEADERS" == *'insufficient_scope'* ]]; then
    pass "token without mcp/read -> 403 insufficient_scope"
  else
    fail "token without mcp/read -> 403 insufficient_scope" "got $STATUS, headers: $(grep -i www-auth <<<"$HEADERS")"
  fi
else
  echo "SKIP  token without mcp/read (pass --noscope-token-file to run)"
fi

# Method and body checks need a valid token to get past the edge; they run in
# the positive section below.

# ── Positive checks (need a token that carries mcp/read) ─────────────────────

if [[ "$NEGATIVE_ONLY" == "1" ]]; then
  echo
  echo "SKIP  positive checks (--negative-only)"
elif [[ -z "$TOKEN_FILE" ]]; then
  echo
  echo "FAIL  positive checks need --token-file (an access token with mcp/read)."
  echo "      Get one from the authorization-code flow: see examples/mcp-http-api/README.md"
  FAIL=$((FAIL + 1))
else
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  SUB="$(claim "$TOKEN" sub)"
  TOKEN_CLIENT="$(claim "$TOKEN" client_id)"
  TOKEN_USE="$(claim "$TOKEN" token_use)"
  TOKEN_SCOPE="$(claim "$TOKEN" scope)"

  # Preflight: fail early with the real reason instead of a confusing 403 later.
  if [[ "$TOKEN_USE" != "access" ]]; then
    fail "preflight token_use=access" "got '$TOKEN_USE'"
  else
    pass "preflight token_use=access"
  fi
  if [[ -n "$CLIENT_ID" && "$TOKEN_CLIENT" != "$CLIENT_ID" ]]; then
    fail "preflight client_id is MCP app client" "token client_id=$TOKEN_CLIENT, expected $CLIENT_ID"
  else
    pass "preflight client_id is MCP app client"
  fi
  if [[ " $TOKEN_SCOPE " == *" mcp/read "* ]]; then
    pass "preflight scope includes mcp/read"
  else
    fail "preflight scope includes mcp/read" "scope='$TOKEN_SCOPE' (re-run the auth flow with scope=openid email mcp/read)"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  if [[ "$STATUS" == "200" ]] && [[ "$(jq_py 'd["result"]["serverInfo"]["name"]' <<<"$BODY")" != "" ]]; then
    pass "initialize -> 200 with serverInfo"
  else
    fail "initialize -> 200 with serverInfo" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  if [[ "$STATUS" == "202" && -z "$BODY" ]]; then pass "notifications/initialized -> 202 empty"; else fail "notifications/initialized -> 202 empty" "got $STATUS: $BODY"; fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  if [[ "$(jq_py '[t["name"] for t in d["result"]["tools"]]' <<<"$BODY")" == *"get_my_bookings"* ]]; then
    pass "tools/list contains get_my_bookings"
  else
    fail "tools/list contains get_my_bookings" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_my_bookings","arguments":{}}}'
  if [[ "$STATUS" == "200" && "$(jq_py 'd["result"]["isError"]' <<<"$BODY")" == "False" ]]; then
    TEXT="$(jq_py 'd["result"]["content"][0]["text"]' <<<"$BODY")"
    OWNER="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['owner'])" "$TEXT" 2>/dev/null)"
    COUNT="$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])['bookings']))" "$TEXT" 2>/dev/null)"
    if [[ "$OWNER" == "$SUB" ]]; then
      pass "tools/call get_my_bookings -> owner == token sub ($COUNT bookings)"
    else
      fail "tools/call get_my_bookings -> owner == token sub" "owner=$OWNER sub=$SUB"
    fi
    # Every returned booking must come back from the same owner's partition; the
    # backend strips pk, so the check is that no sk points at another owner.
    if python3 -c "import json,sys; b=json.loads(sys.argv[1])['bookings']; sys.exit(0 if all(x.get('sk','').startswith('BOOKING#') for x in b) else 1)" "$TEXT"; then
      pass "all returned bookings are BOOKING# rows"
    else
      fail "all returned bookings are BOOKING# rows" "$TEXT"
    fi
  else
    fail "tools/call get_my_bookings -> 200, isError=false" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_my_bookings","arguments":{"status":"confirmed"}}}'
  TEXT="$(jq_py 'd["result"]["content"][0]["text"]' <<<"$BODY")"
  if [[ "$STATUS" == "200" ]] && python3 -c "import json,sys; b=json.loads(sys.argv[1])['bookings']; sys.exit(0 if all(x['status']=='confirmed' for x in b) else 1)" "$TEXT" 2>/dev/null; then
    pass "status filter confirmed -> only confirmed rows"
  else
    fail "status filter confirmed -> only confirmed rows" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}'
  if [[ "$(jq_py 'd["error"]["code"]' <<<"$BODY")" == "-32602" ]]; then
    pass "unknown tool -> JSON-RPC -32602"
  else
    fail "unknown tool -> JSON-RPC -32602" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{not json'
  if [[ "$STATUS" == "400" && "$(jq_py 'd["error"]["code"]' <<<"$BODY")" == "-32700" ]]; then
    pass "malformed JSON -> 400 parse error"
  else
    fail "malformed JSON -> 400 parse error" "got $STATUS: $BODY"
  fi

  request "$TOKEN" "" GET
  if [[ "$STATUS" == "405" ]]; then pass "GET /mcp -> 405"; else fail "GET /mcp -> 405" "got $STATUS: $BODY"; fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
