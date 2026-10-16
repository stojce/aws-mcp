# MCP on AWS

Vocabulary for exposing Guryou's existing per-user API surface as an MCP server via Amazon Bedrock AgentCore Gateway.

## Language

**MCP app client**:
The dedicated Cognito app client on the existing User Pool whose tokens are the only ones the Gateway accepts at the MCP edge. `sub` of its tokens is the real end user.
_Avoid_: MCP client (ambiguous with MCP client software), web client

**Gateway**:
The Amazon Bedrock AgentCore Gateway: managed MCP endpoint that authenticates inbound JWTs (`CUSTOM_JWT`) and invokes its configured targets. One Gateway for this effort.
_Avoid_: Bedrock Gateway, API Gateway (that's the existing HTTP API boundary, a different thing)

**Lambda target**:
A Gateway target of type Lambda, invoked by the Gateway under its service role. The existing Apollo `graphql.ts` Lambda is the target for this effort's tools.
_Avoid_: wrapper Lambda (no wrapper is added before the target)

**Interceptor**:
A request interceptor Lambda the Gateway calls before a target invocation; it copies selected claims from the validated inbound JWT into the request. The per-user identity channel for Lambda targets.
_Avoid_: Lambda authorizer (that's the existing API GW pattern, currently bypassed — different mechanism)

**Claims**:
The per-user authorization facts (`userId`, `userRole`, `providerId`, `isAnonymous`) resolved by `libs/auth-cognito`'s `normalizeClaims`. The Gateway itself never derives these; they arrive via the interceptor.
_Avoid_: token claims (over-broad; "Claims" here means the normalized app-level set)

**Tool schema**:
The MCP `toolSchema` object declared per gateway target in Terraform; hand-derived from the matching GraphQL operation's input/output types so the MCP surface stays stable while GraphQL evolves.

**mcp.read / mcp.write**:
The Cognito resource-server scopes on the MCP app client. `mcp.read` exists at v1; `mcp.write` is reserved for future mutation tools.
