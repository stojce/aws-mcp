#!/usr/bin/env bash
# Smoke test for the deployed MCP endpoint (examples/mcp-http-api).
#
# Usage:
#   scripts/smoke.sh --token-file access.token [--noscope-token-file other.token]
#   scripts/smoke.sh --negative-only              # no token needed
#
# Inputs (flags override env):
#   --token-file FILE          resource-bound access token WITH the required scope, from authorization-code + PKCE
#   --noscope-token-file FILE  resource-bound token from the same client WITHOUT the required scope (expects 403)
#   --url URL                  MCP endpoint (default: terraform output mcp_url)
#   --client-id ID             MCP app client id (default: terraform output mcp_app_client_id)
#   --scope SCOPE              required scope (default: terraform output required_scope)
#   --authorization-mode MODE  cognito (default) or external
#   --client-id-claim CLAIM    verified client claim (default: client_id; external providers may use azp)
#   --negative-only            run only the checks that need no valid token
#
# Exit 0 = all checks passed; 1 = at least one failed.

set -uo pipefail

cd "$(dirname "$0")/.."

TOKEN_FILE="${SMOKE_TOKEN_FILE:-}"
NOSCOPE_TOKEN_FILE="${SMOKE_NOSCOPE_TOKEN_FILE:-}"
MCP_URL="${SMOKE_MCP_URL:-}"
CLIENT_ID="${SMOKE_CLIENT_ID:-}"
REQUIRED_SCOPE="${SMOKE_REQUIRED_SCOPE:-}"
NEGATIVE_ONLY="${SMOKE_NEGATIVE_ONLY:-0}"
AUTHORIZATION_MODE="${SMOKE_AUTHORIZATION_MODE:-cognito}"
CLIENT_ID_CLAIM="${SMOKE_CLIENT_ID_CLAIM:-client_id}"
PROTOCOL_VERSION="2026-07-28"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --noscope-token-file) NOSCOPE_TOKEN_FILE="$2"; shift 2 ;;
    --url) MCP_URL="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --scope) REQUIRED_SCOPE="$2"; shift 2 ;;
    --authorization-mode) AUTHORIZATION_MODE="$2"; shift 2 ;;
    --client-id-claim) CLIENT_ID_CLAIM="$2"; shift 2 ;;
    --negative-only) NEGATIVE_ONLY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$AUTHORIZATION_MODE" != "cognito" && "$AUTHORIZATION_MODE" != "external" ]]; then
  echo "--authorization-mode must be cognito or external" >&2
  exit 2
fi

if [[ -z "$MCP_URL" ]]; then
  MCP_URL="$(terraform output -raw mcp_url 2>/dev/null || true)"
fi
if [[ -z "$CLIENT_ID" ]]; then
  CLIENT_ID="$(terraform output -raw mcp_app_client_id 2>/dev/null || true)"
fi
if [[ -z "$REQUIRED_SCOPE" ]]; then
  REQUIRED_SCOPE="$(terraform output -raw required_scope 2>/dev/null || true)"
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
  local -a metadata_headers=()
  if [[ "$method" == "POST" ]]; then
    local prepared rpc_method rpc_name
    prepared="$(python3 -c '
import base64, json, re, sys
raw, version = sys.argv[1:]
try:
    msg = json.loads(raw)
except json.JSONDecodeError:
    msg = None
rpc_method, rpc_name = "", ""
if isinstance(msg, dict):
    rpc_method = msg.get("method", "")
    params = msg.setdefault("params", {}) if "id" in msg else msg.get("params", {})
    if "id" in msg:
        params["_meta"] = {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "smoke", "version": "0"},
        }
    if rpc_method in ("tools/call", "prompts/get"):
        rpc_name = params.get("name", "")
    elif rpc_method == "resources/read":
        rpc_name = params.get("uri", "")
    if rpc_name and (not re.fullmatch(r"[\x20-\x7E\t]*", rpc_name)
                     or rpc_name.strip() != rpc_name
                     or (rpc_name.startswith("=?base64?") and rpc_name.endswith("?="))):
        rpc_name = "=?base64?" + base64.b64encode(rpc_name.encode("utf-8")).decode("ascii") + "?="
print(json.dumps({"body": json.dumps(msg) if msg is not None else raw,
                  "method": rpc_method, "name": rpc_name}))
' "$body" "$PROTOCOL_VERSION")"
    body="$(jq_py 'd["body"]' <<<"$prepared")"
    rpc_method="$(jq_py 'd["method"]' <<<"$prepared")"
    rpc_name="$(jq_py 'd["name"]' <<<"$prepared")"
    [[ -n "$rpc_method" ]] && metadata_headers+=(-H "Mcp-Method: $rpc_method")
    [[ -n "$rpc_name" ]] && metadata_headers+=(-H "Mcp-Name: $rpc_name")
  fi
  local raw
  raw="$(curl -sS -o "$tmp" -D "$tmp.h" -w '%{http_code}' -X "$method" "$MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -H "MCP-Protocol-Version: $PROTOCOL_VERSION" \
    "${metadata_headers[@]}" "${auth[@]}" --data-binary "$body" 2>"$tmp.err")" || raw="000"
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
value = json.loads(base64.urlsafe_b64decode(p)).get(key, '')
if key in ('scope', 'scp') and isinstance(value, list):
    value = ' '.join(value) if all(isinstance(item, str) for item in value) else ''
print(json.dumps(value) if key == 'aud' else value)
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
  if [[ "$STATUS" == "403" ]]; then
    pass "resource-bound token without the required scope -> 403"
  else
    fail "resource-bound token without the required scope -> 403" "got $STATUS"
  fi
else
  echo "SKIP  token without the required scope (pass --noscope-token-file to run)"
fi

# Method and body checks need a valid token to get past the edge; they run in
# the positive section below.

# ── Positive checks (need a token that carries the required scope) ───────────

if [[ "$NEGATIVE_ONLY" == "1" ]]; then
  echo
  echo "SKIP  positive checks (--negative-only)"
elif [[ -z "$TOKEN_FILE" ]]; then
  echo
  echo "FAIL  positive checks need --token-file (aud=mcp_url and the required scope)."
  echo "      Use authorization-code + PKCE with resource=mcp_url: see examples/mcp-http-api/README.md"
  FAIL=$((FAIL + 1))
elif [[ -z "$REQUIRED_SCOPE" ]]; then
  fail "required scope is configured" "Pass --scope or run from an applied example."
else
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  SUB="$(claim "$TOKEN" sub)"
  TOKEN_CLIENT="$(claim "$TOKEN" "$CLIENT_ID_CLAIM")"
  TOKEN_USE="$(claim "$TOKEN" token_use)"
  TOKEN_SCOPE="$(claim "$TOKEN" scope)"
  [[ -z "$TOKEN_SCOPE" ]] && TOKEN_SCOPE="$(claim "$TOKEN" scp)"
  TOKEN_AUD="$(claim "$TOKEN" aud)"

  # Preflight: fail early with the real reason instead of a confusing 403 later.
  if [[ "$AUTHORIZATION_MODE" == "external" && -z "$TOKEN_USE" ]]; then
    pass "preflight external access-token contract is checked by the server"
  elif [[ "$TOKEN_USE" != "access" ]]; then
    fail "preflight token_use=access" "got '$TOKEN_USE'"
  else
    pass "preflight token_use=access"
  fi
  if [[ -n "$CLIENT_ID" && "$TOKEN_CLIENT" != "$CLIENT_ID" ]]; then
    fail "preflight client claim is MCP app client" "token $CLIENT_ID_CLAIM=$TOKEN_CLIENT, expected $CLIENT_ID"
  else
    pass "preflight client claim is MCP app client"
  fi
  if [[ " $TOKEN_SCOPE " == *" $REQUIRED_SCOPE "* ]]; then
    pass "preflight scope includes the required scope"
  else
    fail "preflight scope includes the required scope" "scope='$TOKEN_SCOPE' (re-run the auth flow with the required scope $REQUIRED_SCOPE)"
  fi
  if [[ "$(python3 -c 'import json,sys; aud=json.loads(sys.argv[1]); expected,mode=sys.argv[2:]; print(aud == expected or (mode == "cognito" and isinstance(aud, list) and expected in aud))' "$TOKEN_AUD" "$MCP_URL" "$AUTHORIZATION_MODE")" == "True" ]]; then
    pass "preflight aud binds mcp_url"
  else
    fail "preflight aud binds mcp_url" "External providers need a single string aud=mcp_url. Request resource=mcp_url in both authorization and token requests."
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'
  if [[ "$STATUS" == "200" ]] && [[ "$(jq_py 'd["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"]' <<<"$BODY")" != "" ]] && [[ "$(jq_py '"2026-07-28" in d["result"]["supportedVersions"] and d["result"]["resultType"] == "complete" and d["result"]["ttlMs"] >= 0 and d["result"]["cacheScope"] == "private"' <<<"$BODY")" == "True" ]]; then
    pass "server/discover -> 200 with modern capabilities and serverInfo"
  else
    fail "server/discover -> 200 with modern capabilities and serverInfo" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  if [[ "$(jq_py '[t["name"] for t in d["result"]["tools"]]' <<<"$BODY")" == *"get_my_bookings"* ]]; then
    pass "tools/list contains get_my_bookings"
  else
    fail "tools/list contains get_my_bookings" "got $STATUS: $BODY"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_my_bookings","arguments":{}}}'
  if [[ "$STATUS" == "200" && "$(jq_py 'd["result"]["isError"]' <<<"$BODY")" == "False" && "$(jq_py 'd["result"]["resultType"]' <<<"$BODY")" == "complete" ]]; then
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

  request "$TOKEN" '{"jsonrpc":"2.0","id":6,"method":"ping"}'
  if [[ "$STATUS" == "404" && "$(jq_py 'd["error"]["code"]' <<<"$BODY")" == "-32601" ]]; then
    pass "modern ping -> 404 method not found"
  else
    fail "modern ping -> 404 method not found" "got $STATUS: $BODY"
  fi

  request "$TOKEN" "" GET
  if [[ "$STATUS" == "405" ]]; then pass "GET /mcp -> 405"; else fail "GET /mcp -> 405" "got $STATUS: $BODY"; fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
