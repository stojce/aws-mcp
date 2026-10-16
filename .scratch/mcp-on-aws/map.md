# Map: MCP server on AWS for existing API

Type: wayfinder:map
Status: open

## Destination

An **ADR-style decision document** in this repo answering: is exposing the existing API surface (API Gateway + Cognito authorizer → Lambda; existing GraphQL endpoint) as a world-facing MCP server advisable via **Amazon Bedrock AgentCore Gateway** (decided: yes), how inbound/outbound authentication and authorization work, and what the **Terraform module contract** looks like (module lives in this repo). Reaching the end of the map = the ADR is written, complete, and its Terraform contract is decision-complete.

## Notes

- Domain: AWS security/infra; existing stack = **guryou-mono** (`~/Projects/gy/guryou-mono`, `stage2` branch/worktree), region **eu-west-1**; infra in **guryou-infra-terraform** (`~/Projects/gy/guryou-infra-terraform`). Existing APIs: `proxy` (GraphQL, Apollo Server in `api/proxy/src/lambdas/graphql.ts`) and `training`. Auth is **custom Lambda-authorizer pattern** (code in `libs/auth-cognito`, `REQUEST`-type authorizer in `modules/api/api_gw.tf`, currently `authorization_type = "NONE"` at API GW edge, auth enforced inside the Lambda via `decodeCognitoJwtToken` + legacy fallback). Cognito pool managed in `modules/cognito/`. Lambda list and Apollo `graphql.ts` confirmed; the `graphql.ts` context fn already reads `event.headers.authorization`. Graphql resolver surface at `stage2/api/proxy/src/graphql/` (generated resolvers + hand-written `resolvers` in `datasources`).
- **Executed answers already locked in round 1:** AgentCore Gateway (vs self-built) is _chosen_; destination is a decision doc, not shipped code; consumers are **end users of your app with per-user data isolation**; tools are **wrap existing Lambdas as-is**; scope is **2–5 curated high-value operations**; module lives in **this repo**.
- Tracker: **local-markdown** under `.scratch/mcp-on-aws/` (map + `issues/NN-<slug>.md`).
- Skills to consult per session: `grilling`, `domain-modeling`, `research` (for AWS/Terraform fact-finding); `amazon-bedrock` and `aws-auth` and `aws-serverless` are relevant when the topic surfaces.

## Decisions so far

- [Ticket 01 — AgentCore Gateway auth: Cognito inbound per-user, Lambda target outbound](issues/01-agentcore-gateway-auth-research.md): Cognito reuse works inbound (CUSTOM_JWT, grant-agnostic); **no automatic per-user identity propagation to Lambda targets** — interceptor-injected claims (or HTTP-target passthrough/OBO) is the documented pattern; API-GW-stage targets can't speak Cognito OAuth (use OpenAPI/MCP target + CognitoOauth2 provider).
- [Ticket 02 — Terraform provider support](issues/02-terraform-provider-support.md): full `aws_bedrockagentcore_*` coverage in `hashicorp/aws` — no fallbacks; gateway/targets from v6.17.0, **min v6.21.0**, prefer >= 6.34.0.
- [Ticket 03 — Region availability](issues/03-region-availability.md): AgentCore Gateway broadly available in major AgentCore regions; **user must still confirm existing stack's region** for the 1-line check. **Confirmed in map notes**: eu-west-1 = yes, full family.
- [Ticket 07 — Inbound auth shape](issues/07-inbound-auth-shape.md): Gateway bound to dedicated MCP app client only (web tokens replay-blocked); resource server with `mcp.read` now + `mcp.write` reserved; user tokens via existing authorization-code flow (real `sub` for per-user isolation).
- [Ticket 06 — Curate tool set v1](issues/06-curate-tool-set-v1.md): end-user (customer-facing) assistant; v1 tools = per-user booking/subscription **reads** (`getMyBookedEvents`, `getCustomerEvents` + 1–3 sibling reads), hand-derived `toolSchema` per tool, no mutations at v1; crons/infra lambdas excluded.
- [Ticket 05 — Terraform module contract](issues/05-terraform-module-contract.md): module creates MCP app client + resource server + gateway + targets (`targets` var list) + execution role; no outbound credential providers at v1 (hook seam reserved); outputs = gateway URL/id, role ARN, app client id, tool names; no one_time flag.
- [Ticket 08 — Write the ADR](issues/08-write-the-adr.md): ADR written at `docs/adr/0001-agentcore-gateway-mcp.md`; `GLOSSARY.md` created. **Map complete — destination reached.**
- [Ticket 04 — Advisability verdict](issues/04-advisability-verdict.md): **YES — AgentCore Gateway advisable** for this stack. Keep existing Apollo graphql.ts lambda as-is as Lambda target; compensate for missing per-user identity propagation via interceptor-injected claims; reuse existing Cognito pool + dedicated MCP app client + dedicated resource-server `mcp.*` scopes; fallback trigger documented (JWT_PASSTHROUGH/OBO on HTTP targets as pivot, not v1).

## Not yet specified

- **GraphQL endpoint exposure** — now decided by tickets 04+06: Lambda-target on the existing Apollo graphql.ts lambda; raw-GraphQL-over-HTTP-target and OpenAPI-target routes are the documented fallback pivot, not v1. No remaining fog on this thread.
- **ADR structure and location**: graduated to [Ticket 08 — Write the ADR](issues/08-write-the-adr.md). No fog remains: the frontier is that single ticket, and resolving it = the destination's end.

## Out of scope

- Shipping the actual Terraform code. Destination is the decision doc; the map ends when the ADR is written. (Wayfinder "plan, don't do" default.)
- Building the actual thin tool-shaped Lambda adapters for the GraphQL endpoint. Decision recorded if applicable; implementation is later work.
