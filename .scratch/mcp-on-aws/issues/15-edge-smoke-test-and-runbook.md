# Ticket 15: Edge smoke test + connection runbook

Type: task
Status: resolved (code + runbook done; live run pending offline choice on ticket 11)

## Answer

- **`scripts/mcp-edge-smoke.mjs`**: raw-MCP (JSON-RPC) smoke client asserting: valid-token `tools/list` 200 with curated names; `tools/call` completing without `isError` (user data spot-check printed as userIds); optional negative token rejected at the edge. Syntax-checked; fail-path drives (unreachable endpoint exits 1 with message).
- **`docs/runbook-mcp-gateway.md`**: connection runbook — token acquisition via the MCP app client (authorization-code + PKCE, `mcp/read`), endpoint from module outputs, smoke command, tool list, operational notes (interceptor-isolation review checkpoint, role scope, CloudTrail sub note, reserved pivots).

## Acceptance criteria

- [x] Smoke script asserts valid-token read, edge-rejection behavior for negative token.
- [x] Runbook written with connect steps + token flow + tool names + endpoint source.
- [ ] Live execution of all four smoke asserts (blocked by the offline choice recorded on ticket 11; the exe stub is ready for the first apply).
- [x] No mutation tools at v1 (nothing in `targets` mutates; no `mcp.write` scope exists).
