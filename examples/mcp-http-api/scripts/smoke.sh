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
#   --origin ORIGIN            check browser CORS and send this Origin on MCP requests
#   --samples COUNT            measure COUNT additional direct tools/list requests (0-100; default 0)
#   --other-token-file FILE    access token for a second user; verify separate bookings
#   --negative-only            run only the checks that need no valid token
#
# Exit 0 = all checks passed; 1 = at least one failed.

set -uo pipefail

cd "$(dirname "$0")/.."

TOKEN_FILE="${SMOKE_TOKEN_FILE:-}"
OTHER_TOKEN_FILE="${SMOKE_OTHER_TOKEN_FILE:-}"
NOSCOPE_TOKEN_FILE="${SMOKE_NOSCOPE_TOKEN_FILE:-}"
MCP_URL="${SMOKE_MCP_URL:-}"
CLIENT_ID="${SMOKE_CLIENT_ID:-}"
REQUIRED_SCOPE="${SMOKE_REQUIRED_SCOPE:-}"
NEGATIVE_ONLY="${SMOKE_NEGATIVE_ONLY:-0}"
AUTHORIZATION_MODE="${SMOKE_AUTHORIZATION_MODE:-cognito}"
CLIENT_ID_CLAIM="${SMOKE_CLIENT_ID_CLAIM:-client_id}"
ORIGIN="${SMOKE_ORIGIN:-}"
SAMPLE_COUNT="${SMOKE_SAMPLES:-0}"
PROTOCOL_VERSION="2026-07-28"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --other-token-file) OTHER_TOKEN_FILE="$2"; shift 2 ;;
    --noscope-token-file) NOSCOPE_TOKEN_FILE="$2"; shift 2 ;;
    --url) MCP_URL="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --scope) REQUIRED_SCOPE="$2"; shift 2 ;;
    --authorization-mode) AUTHORIZATION_MODE="$2"; shift 2 ;;
    --client-id-claim) CLIENT_ID_CLAIM="$2"; shift 2 ;;
    --origin) ORIGIN="$2"; shift 2 ;;
    --samples) SAMPLE_COUNT="$2"; shift 2 ;;
    --negative-only) NEGATIVE_ONLY=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$SAMPLE_COUNT" =~ ^[0-9]+$ ]] || (( ${#SAMPLE_COUNT} > 3 )) || (( 10#$SAMPLE_COUNT > 100 )); then
  echo "--samples must be an integer from 0 to 100" >&2
  exit 2
fi
SAMPLE_COUNT=$((10#$SAMPLE_COUNT))

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
# Response bodies and token claims can contain private user data. Report the
# failed assertion without echoing those diagnostics into a shareable log.
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }

# Sets $STATUS, $BODY, $HEADERS (lower-cased), and $DURATION_S.
# $1 = token ("" for none), $2 = body, $3 = HTTP method, $4 = URL override.
request() {
  local token="$1" body="$2" method="${3:-POST}" url="${4:-$MCP_URL}"
  local tmp; tmp="$(mktemp)"
  local -a auth=()
  [[ -n "$token" ]] && auth=(-H "Authorization: Bearer $token")
  local -a metadata_headers=()
  [[ -n "$ORIGIN" ]] && metadata_headers+=(-H "Origin: $ORIGIN")
  if [[ "$method" == "OPTIONS" ]]; then
    metadata_headers+=(-H 'Access-Control-Request-Method: POST'
      -H 'Access-Control-Request-Headers: content-type,accept,mcp-protocol-version,mcp-method,mcp-name,authorization')
  fi
  if [[ "$method" == "POST" ]]; then
    metadata_headers+=(-H "MCP-Protocol-Version: $PROTOCOL_VERSION")
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
  raw="$(curl -sS --max-time 35 -o "$tmp" -D "$tmp.h" -w '%{http_code} %{time_total}' -X "$method" "$url" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    "${metadata_headers[@]}" "${auth[@]}" --data-binary "$body" 2>"$tmp.err")" || raw="000"
  STATUS="${raw%% *}"
  DURATION_S="${raw#* }"
  BODY="$(cat "$tmp")"
  HEADERS="$(tr -d '\r' < "$tmp.h" | tr '[:upper:]' '[:lower:]')"
  if [[ "$raw" == "000" ]]; then BODY="curl: $(cat "$tmp.err")"; fi
  rm -f "$tmp" "$tmp.h" "$tmp.err"
}

# Read a field from JSON on stdin with a python expression over `d`.
jq_py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

header_value() {
  python3 -c 'import sys; name=sys.argv[1]+":"; print(",".join(line[len(name):].strip() for line in sys.stdin if line.startswith(name)))' "$1" <<<"$HEADERS"
}

header_has_token() {
  python3 -c 'import sys; sys.exit(sys.argv[1] not in {x.strip() for x in sys.stdin.read().split(",")})' "$2" <<<"$(header_value "$1")"
}

stateless_response() {
  if [[ -z "$(header_value mcp-session-id)" ]]; then
    pass "$1 does not issue a session identifier"
  else
    fail "$1 does not issue a session identifier"
  fi
}

browser_response() {
  if [[ -n "$ORIGIN" ]]; then
    if [[ "$(header_value access-control-allow-origin)" == "$ORIGIN" ]] || [[ "${2:-}" == "public" && "$(header_value access-control-allow-origin)" == "*" ]]; then
      pass "$1 allows the configured browser origin"
    else
      fail "$1 allows the configured browser origin"
    fi
  fi
}

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

if [[ -n "$ORIGIN" ]]; then
  request "" "" OPTIONS
  if [[ "$STATUS" == "204" && "$(header_value access-control-allow-origin)" == "$ORIGIN" ]]; then
    pass "browser preflight is public and allows the exact origin"
  else
    fail "browser preflight is public and allows the exact origin"
  fi
  if header_has_token access-control-allow-methods post && [[ "$(header_value access-control-allow-credentials)" != "true" ]]; then
    pass "browser preflight allows POST without cookie credentials"
  else
    fail "browser preflight allows POST without cookie credentials"
  fi
  ALLOWED_HEADERS="$(header_value access-control-allow-headers)"
  if python3 -c 'import sys; allowed={x.strip() for x in sys.argv[1].split(",")}; sys.exit(not set(sys.argv[2:]) <= allowed)' \
    "$ALLOWED_HEADERS" content-type accept mcp-protocol-version mcp-method mcp-name authorization; then
    pass "browser preflight allows every modern MCP request header"
  else
    fail "browser preflight allows every modern MCP request header"
  fi
fi

request "" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
if [[ "$STATUS" == "401" ]]; then pass "no token -> 401"; else fail "no token -> 401" "got $STATUS: $BODY"; fi
browser_response "authentication challenge"
if [[ -n "$ORIGIN" ]]; then
  if header_has_token access-control-expose-headers www-authenticate; then
    pass "browser can read the OAuth discovery challenge"
  else
    fail "browser can read the OAuth discovery challenge"
  fi
fi
METADATA_URL="$(python3 -c 'import re,sys; m=re.search(r"resource_metadata=\"([^\"]+)\"", sys.stdin.read()); print(m[1] if m else "")' <<<"$HEADERS")"
if [[ -n "$METADATA_URL" ]]; then
  request "" "" GET "$METADATA_URL"
  if [[ "$STATUS" == "200" && "$(jq_py 'd["resource"]' <<<"$BODY")" == "$MCP_URL" ]]; then
    pass "challenge metadata identifies the protected MCP resource"
  else
    fail "challenge metadata identifies the protected MCP resource"
  fi
  browser_response "protected-resource metadata"
  AUTHORIZATION_SERVER="$(jq_py 'd["authorization_servers"][0]' <<<"$BODY")"
  if [[ -n "$AUTHORIZATION_SERVER" ]]; then
    # RFC 8414 inserts the well-known component before an issuer path.
    AUTH_METADATA_URL="$(python3 -c 'from urllib.parse import urlsplit,urlunsplit; import sys; u=urlsplit(sys.argv[1]); print(urlunsplit((u.scheme,u.netloc,"/.well-known/oauth-authorization-server"+u.path.rstrip("/"),"","")))' "$AUTHORIZATION_SERVER")"
    request "" "" GET "$AUTH_METADATA_URL"
    if [[ "$STATUS" != "200" ]]; then
      request "" "" GET "${AUTHORIZATION_SERVER%/}/.well-known/openid-configuration"
    fi
    if [[ "$STATUS" == "200" && "$(jq_py 'd["issuer"]' <<<"$BODY")" == "$AUTHORIZATION_SERVER" && "$(jq_py '"S256" in d["code_challenge_methods_supported"] and "authorization_code" in d.get("grant_types_supported", ["authorization_code", "implicit"])' <<<"$BODY")" == "True" ]]; then
      pass "OAuth metadata identifies the issuer and advertises S256 and authorization code"
    else
      fail "OAuth metadata identifies the issuer and advertises S256 and authorization code"
    fi
    browser_response "authorization-server metadata" public
    if [[ "$AUTHORIZATION_MODE" == "cognito" && "$AUTHORIZATION_SERVER" == "${MCP_URL%/mcp}" ]]; then
      if [[ "$(jq_py 'd.get("client_id_metadata_document_supported") is False and "registration_endpoint" not in d and "refresh_token" in d["grant_types_supported"]' <<<"$BODY")" == "True" ]]; then
        pass "OAuth metadata explicitly declares pre-registered clients and refresh support"
      else
        fail "OAuth metadata explicitly declares pre-registered clients and refresh support"
      fi
    fi
  else
    fail "protected-resource metadata identifies an authorization server"
  fi
  if [[ -n "$ORIGIN" ]]; then
    TRUSTED_ORIGIN="$ORIGIN"
    ORIGIN="https://untrusted.invalid"
    request "" "" GET "$METADATA_URL"
    if [[ "$STATUS" == "403" && -z "$(header_value access-control-allow-origin)" ]]; then
      pass "untrusted browser origin is denied"
    else
      fail "untrusted browser origin is denied"
    fi
    ORIGIN="$TRUSTED_ORIGIN"
  fi
else
  fail "authentication challenge includes a metadata URL"
fi

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

  # Modern requests can start with tools/list on a fresh connection.
  request "$TOKEN" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  if [[ "$STATUS" == "200" ]]; then
    pass "tools/list succeeds before discovery or initialization"
  else
    fail "tools/list succeeds before discovery or initialization"
  fi
  stateless_response "initial tools/list"
  browser_response "initial tools/list"

  request "$TOKEN" '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'
  if [[ "$STATUS" == "200" ]] && [[ "$(jq_py 'd["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"]' <<<"$BODY")" != "" ]] && [[ "$(jq_py '"2026-07-28" in d["result"]["supportedVersions"] and d["result"]["resultType"] == "complete" and d["result"]["ttlMs"] >= 0 and d["result"]["cacheScope"] == "private"' <<<"$BODY")" == "True" ]]; then
    pass "server/discover -> 200 with modern capabilities and serverInfo"
  else
    fail "server/discover -> 200 with modern capabilities and serverInfo" "got $STATUS: $BODY"
  fi
  stateless_response "server/discover"
  if [[ "$(jq_py 'd["result"]["capabilities"] == {"tools": {"listChanged": False}}' <<<"$BODY")" == "True" ]]; then
    pass "discovery declares the implemented tool-only capabilities"
  else
    fail "discovery declares the implemented tool-only capabilities"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  if [[ "$(jq_py '[t["name"] for t in d["result"]["tools"]]' <<<"$BODY")" == *"get_my_bookings"* ]]; then
    pass "tools/list contains get_my_bookings"
  else
    fail "tools/list contains get_my_bookings" "got $STATUS: $BODY"
  fi
  if [[ "$(jq_py 'next(t for t in d["result"]["tools"] if t["name"] == "get_my_bookings")["inputSchema"].get("additionalProperties") is False' <<<"$BODY")" == "True" ]]; then
    pass "bookings schema rejects undeclared properties"
  else
    fail "bookings schema rejects undeclared properties"
  fi
  if [[ "$(jq_py 'bool(next(t for t in d["result"]["tools"] if t["name"] == "get_my_bookings")["inputSchema"]["properties"]["status"].get("description", "").strip())' <<<"$BODY")" == "True" ]]; then
    pass "bookings status has a property description"
  else
    fail "bookings status has a property description"
  fi

  request "$TOKEN" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_my_bookings","arguments":{}}}'
  if [[ "$STATUS" == "200" && "$(jq_py 'd["result"]["isError"]' <<<"$BODY")" == "False" && "$(jq_py 'd["result"]["resultType"]' <<<"$BODY")" == "complete" ]]; then
    TEXT="$(jq_py 'd["result"]["content"][0]["text"]' <<<"$BODY")"
    OWNER="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['owner'])" "$TEXT" 2>/dev/null)"
    COUNT="$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])['bookings']))" "$TEXT" 2>/dev/null)"
    FIRST_BOOKING_IDS="$(python3 -c 'import json,sys; print(json.dumps([b["id"] for b in json.load(sys.stdin)["bookings"]]))' <<<"$TEXT" 2>/dev/null)"
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
  stateless_response "tools/call"
  browser_response "tools/call"

  for booking_status in confirmed cancelled past; do
    request "$TOKEN" "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_my_bookings\",\"arguments\":{\"status\":\"$booking_status\"}}}"
    if [[ "$STATUS" == "200" ]] && python3 -c 'import json,sys; d=json.load(sys.stdin)["result"]; payload=json.loads(d["content"][0]["text"]); sys.exit(not (d["isError"] is False and payload["owner"] == sys.argv[1] and all(b["status"] == sys.argv[2] for b in payload["bookings"])))' "$SUB" "$booking_status" <<<"$BODY" 2>/dev/null; then
      pass "status filter $booking_status -> only matching rows"
    else
      fail "status filter $booking_status -> only matching rows"
    fi
  done

  for invalid_arguments in '{"status":"unknown"}' '{"status":42}' '{"owner":"another-user"}' '{"identity":{"sub":"another-user"}}'; do
    request "$TOKEN" "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_my_bookings\",\"arguments\":$invalid_arguments}}"
    if [[ "$STATUS" == "200" && "$(jq_py 'd["result"]["isError"] is True and d["result"]["resultType"] == "complete"' <<<"$BODY")" == "True" ]]; then
      pass "invalid tool arguments -> complete tool error"
    else
      fail "invalid tool arguments -> complete tool error"
    fi
    browser_response "tool validation error"
  done

  if [[ -n "$OTHER_TOKEN_FILE" ]]; then
    OTHER_TOKEN="$(tr -d '[:space:]' < "$OTHER_TOKEN_FILE")"
    OTHER_SUB="$(claim "$OTHER_TOKEN" sub)"
    request "$OTHER_TOKEN" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_my_bookings","arguments":{}}}'
    if [[ -n "$OTHER_SUB" && "$OTHER_SUB" != "$SUB" && "$STATUS" == "200" ]] && python3 -c 'import json,sys; result=json.load(sys.stdin)["result"]; d=json.loads(result["content"][0]["text"]); previous=set(json.loads(sys.argv[2])); sys.exit(not (result["isError"] is False and d["owner"] == sys.argv[1] and not previous.intersection(b["id"] for b in d["bookings"])))' "$OTHER_SUB" "${FIRST_BOOKING_IDS:-[]}" <<<"$BODY" 2>/dev/null; then
      pass "two users receive separate bookings"
    else
      fail "two users receive separate bookings"
    fi
  else
    echo "SKIP  second-user isolation (pass --other-token-file to run)"
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

  for optional_method in resources/list resources/templates/list prompts/list tasks/list; do
    request "$TOKEN" "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"$optional_method\"}"
    if [[ "$STATUS" == "404" && "$(jq_py 'd["error"]["code"]' <<<"$BODY")" == "-32601" ]]; then
      pass "$optional_method is explicitly unsupported"
    else
      fail "$optional_method is explicitly unsupported"
    fi
    browser_response "unsupported method"
  done

  PROTOCOL_VERSION="2025-06-18"
  request "$TOKEN" '{"jsonrpc":"2.0","id":8,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  if [[ "$STATUS" == "200" && "$(jq_py 'd["result"]["protocolVersion"]' <<<"$BODY")" == "$PROTOCOL_VERSION" ]]; then
    pass "legacy initialization still negotiates 2025-06-18"
  else
    fail "legacy initialization still negotiates 2025-06-18"
  fi
  stateless_response "legacy initialize"
  request "$TOKEN" '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'
  if [[ "$STATUS" == "200" ]]; then pass "legacy tools/list needs no session"; else fail "legacy tools/list needs no session"; fi
  PROTOCOL_VERSION="2026-07-28"

  SAVED_ORIGIN="$ORIGIN"
  ORIGIN=""
  request "$TOKEN" '{"jsonrpc":"2.0","id":10,"method":"tools/list"}'
  if [[ "$STATUS" == "200" ]]; then pass "native tools/list works without Origin after legacy requests"; else fail "native tools/list works without Origin after legacy requests"; fi
  ORIGIN="$SAVED_ORIGIN"

  if (( SAMPLE_COUNT > 0 )); then
    DURATIONS=""
    for ((sample = 0; sample < SAMPLE_COUNT; sample++)); do
      request "$TOKEN" '{"jsonrpc":"2.0","id":11,"method":"tools/list"}'
      if [[ "$STATUS" != "200" ]]; then
        fail "latency sample tools/list succeeds"
        break
      fi
      DURATIONS="$DURATIONS $DURATION_S"
    done
    python3 -c 'import math,sys; a=sorted(float(x)*1000 for x in sys.stdin.read().split()); print("MEASURE  direct tools/list: samples=%d p50=%.1fms p95=%.1fms (includes network; cold/warm not classified)" % (len(a), a[math.ceil(len(a)*.5)-1], a[math.ceil(len(a)*.95)-1])) if a else None' <<<"$DURATIONS"
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
