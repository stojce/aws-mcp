# Ticket 04: Advisability verdict: AgentCore Gateway for world-facing MCP over an existing per-user API

Type: grilling
Status: resolved
Blocked by: 01, 02, 03

## Question

Given (a) the auth research (#01: does per-user identity propagate to Lambda targets, and how; what the GraphQL outbound path costs), (b) provider support (#02), (c) region availability (#03), and the known constraints (end users with per-user data isolation, wrap existing Lambdas as-is, 2 to 5 curated tools, exposed to the world), reach the **advisability verdict**: is AgentCore Gateway the right choice, or does self-building the MCP server (Lambda MCP server behind your own API GW/Cognito, where your existing authorizer pattern already works per-user) win on per-user authorization fidelity? Write the trade-off table and the verdict. This ticket produces the ADR's spine.

## Answer

Executed decisions (round 2 grilling, session 2, user's own words via structured answers):

- **Verdict: YES, AgentCore Gateway is advisable** as the MCP exposure layer for this stack. Unanimous with research facts: Gateway available in eu-west-1; full `hashicorp/aws` provider coverage; **compensation required**, since no automatic per-user identity propagation to Lambda targets, mitigated via the documented request-interceptor pattern (or a later pivot to JWT_PASSTHROUGH/OBO HTTP targets, noted as fallback not v1).
- **Target pattern: keep existing Apollo graphql.ts lambda as-is behind the Gateway**, exposed as a Lambda target. The wrapper Lambda's `context.client_context.custom` metadata (`bedrockAgentCoreGatewayId`, `bedrockAgentCoreTargetId`, `bedrockAgentCoreToolName`) + interceptor-injected claims becomes the new identity/routing input; `graphql.ts`'s existing `event.headers.authorization` read continues to work for TrainingGateway owner-API forwarding.
- **Inbound auth: reuse the existing Cognito User Pool + a dedicated MCP app client** wired as `allowed_audience`/`allowed_clients` in the Gateway's CUSTOM_JWT authorizer (see ticket 07 for the shape; this ticket fixes the reuse-not-new-pool decision).
- **Scopes: yes, a dedicated Cognito resource server with `mcp.*` scopes on the existing pool**, enforced by the Gateway as "at least one scope in token matches".

Fallback trigger (RSI if interceptor proves insufficient): switch exposed operations to HTTP-target JWT_PASSTHROUGH by moving the boundary; documented in the ADR as a pivot, not v1 outcome.
