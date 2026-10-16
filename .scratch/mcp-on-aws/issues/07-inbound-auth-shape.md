# Ticket 07: Inbound auth for "exposed to the world": Cognito config for external MCP clients

Type: grilling
Status: resolved
Blocked by: 01

## Question

Given #01's facts (Gateway-supported Cognito grant types/scopes and whether identity propagates), grill the user's preference on **inbound auth shape**: (a) one shared app client (simplest; weak per-user isolation at the MCP boundary), (b) one app client per consuming agent-type, (c) external devs concern (out of scope or in?). Decide whether the MCP audience's scopes match the existing API GW authorizer's scopes or get their own resource-server scopes (e.g. `mcp.invoke`), and whether the existing User Pool is reused as-is or gets a dedicated resource server.

## Answer

<!-- filled on resolution -->
## Answer

Inbound auth shape (round 5 grilling; all recommended options accepted; pool-reuse + dedicated app client + resource server already fixed by ticket 04):

- **Audience binding: Gateway `allowed_audience`/`allowed_clients` = the dedicated MCP app client ONLY.** Web-app tokens cannot be replayed at the MCP edge; MCP tokens are separately minted and scoped.
- **Scopes: read/write split**: resource server exposes `mcp.read` now (booking/subscription reads per ticket 06), `mcp.write` reserved for later mutation tools. Least privilege from day one.
- **Grant type: end-user tokens via the existing authorization-code (+PKCE) flow**, so `sub` = real user, satisfying per-user isolation. No client-credentials M2M on the MCP app client at v1 (wrong `sub` semantics for per-user tools).

**Module surface consequence** (feeds ticket 05's contract, already recorded): module creates the MCP **resource server** (`mcp.read`, reserved `mcp.write`) and the dedicated **app client** (server-side callback / authorization-code grant) on the user-supplied existing pool; Gateway `custom_jwt_authorizer` gets `discovery_url` (pool), `allowed_audience`/`allowed_clients` = [app_client_id], `allowed_scopes` = [`mcp.read`].
