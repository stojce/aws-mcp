# Ticket 15: Edge smoke test + connection runbook

**What to build:** the highest seam proves the whole vertical: an MCP client, authenticated with a real end-user token from the MCP app client, calls a v1 read through the live Gateway and gets only that user's data — with the rejection cases proven, not assumed (web-app token rejected at the edge; token without `mcp.read` rejected; a request stripped of injected Claims fails closed via the guard). A short connection runbook records the endpoint URL, token acquisition via the MCP app client, and the expected tool list, so an agent vendor can connect without us.

**Blocked by:** 13 (tools live at the Gateway), 14 (guard fail-closed in the target).

**Status:** ready-for-agent

- [ ] Smoke: valid MCP-app-client token + `mcp.read` → curated read succeeds, returns only the calling user's data.
- [ ] Smoke: web-app-client token → rejected at the Gateway edge.
- [ ] Smoke: token without `mcp.read` → rejected.
- [ ] Smoke: invocation stripped of injected Claims → explicit error (deny-by-default holds end-to-end).
- [ ] Runbook written: connect steps, token flow (authorization-code + PKCE), tool names, endpoint URL from module outputs.
- [ ] No mutation tools reachable at v1 (spot-check `Write` surfaces absent from the tool list).
