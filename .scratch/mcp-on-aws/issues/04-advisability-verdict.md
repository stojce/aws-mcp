# Ticket 04: Advisability verdict: AgentCore Gateway for world-facing MCP over an existing per-user API

Type: grilling
Status: claimed
Blocked by: 01, 02, 03

## Question

Given (a) the auth research (#01: does per-user identity propagate to Lambda targets, and how; what the GraphQL outbound path costs), (b) provider support (#02), (c) region availability (#03), and the known constraints — end users with per-user data isolation, wrap existing Lambdas as-is, 2–5 curated tools, exposed to the world — reach the **advisability verdict**: is AgentCore Gateway the right choice, or does self-building the MCP server (Lambda MCP server behind your own API GW/Cognito, where your existing authorizer pattern already works per-user) win on per-user authorization fidelity? Write the trade-off table and the verdict. This ticket produces the ADR's spine.

## Answer

<!-- filled on resolution -->
