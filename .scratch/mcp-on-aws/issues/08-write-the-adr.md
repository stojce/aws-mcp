# Ticket 08: Write the ADR: AgentCore Gateway MCP for guryou

Type: task
Status: resolved
Blocked by: 04, 05, 06, 07

## Question

Write `docs/adr/0001-agentcore-gateway-mcp.md` in this repo (wayfinder destination: "the ADR is written"). Draw directly on resolved tickets 01–07 (zoom each for detail): verdict + trade-off table (01/04), target pattern + fallback trigger (04), module contract (05), v1 tool set (06), inbound auth shape (07), plus the eu-west-1 + provider-version facts (03/02). Record glossary terms as they crystallize (MCP app client, Gateway, Lambda target, interceptor, caller-forwarding) in `GLOSSARY.md`.

## Answer

<!-- filled on resolution -->
## Answer

Done. Artifacts:

- **`docs/adr/0001-agentcore-gateway-mcp.md`** — the ADR: verdict, the seven-concern decision table (drawing on tickets 01–07), trade-off framing (self-build vs AgentCore Gateway), consequences incl. the dual-boundary note and the interceptor-isolation review checkpoint, and doc links.
- **`GLOSSARY.md`** — new; terms: MCP app client, Gateway, Lambda target, Interceptor, Claims, Tool schema, mcp.read/mcp.write.

The ADR is decision-complete per ticket 05's contract (module creates app client + resource server + gateway + targets + role; outputs fixed; no outbound providers at v1). Destination reached; no further tickets.
