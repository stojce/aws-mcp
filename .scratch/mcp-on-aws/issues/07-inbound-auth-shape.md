# Ticket 07: Inbound auth for "exposed to the world": Cognito config for external MCP clients

Type: grilling
Status: open
Blocked by: 01

## Question

Given #01's facts (Gateway-supported Cognito grant types/scopes and whether identity propagates), grill the user's preference on **inbound auth shape**: (a) one shared app client (simplest; weak per-user isolation at the MCP boundary), (b) one app client per consuming agent-type, (c) external devs concern — out of scope or in? Decide whether the MCP audience's scopes match the existing API GW authorizer's scopes or get their own resource-server scopes (e.g. `mcp.invoke`), and whether the existing User Pool is reused as-is or gets a dedicated resource server.

## Answer

<!-- filled on resolution -->
