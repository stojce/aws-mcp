# Map: MCP server on AWS for existing API

Type: wayfinder:map
Status: open

## Destination

An **ADR-style decision document** in this repo answering: is exposing the existing API surface (API Gateway + Cognito authorizer → Lambda; existing GraphQL endpoint) as a world-facing MCP server advisable via **Amazon Bedrock AgentCore Gateway** (decided: yes), how inbound/outbound authentication and authorization work, and what the **Terraform module contract** looks like (module lives in this repo). Reaching the end of the map = the ADR is written, complete, and its Terraform contract is decision-complete.

## Notes

- Domain: AWS security/infra; existing stack = API Gateway (Cognito authorizer) → Lambda, plus an existing GraphQL endpoint. No code in this repo yet.
- **Executed answers already locked in round 1:** AgentCore Gateway (vs self-built) is _chosen_; destination is a decision doc, not shipped code; consumers are **end users of your app with per-user data isolation**; tools are **wrap existing Lambdas as-is**; scope is **2–5 curated high-value operations**; module lives in **this repo**.
- Tracker: **local-markdown** under `.scratch/mcp-on-aws/` (map + `issues/NN-<slug>.md`).
- Skills to consult per session: `grilling`, `domain-modeling`, `research` (for AWS/Terraform fact-finding); `amazon-bedrock` and `aws-auth` and `aws-serverless` are relevant when the topic surfaces.

## Decisions so far

<!-- one line per resolved ticket: enough to judge relevance, then zoom the link for detail -->

## Not yet specified

- **GraphQL endpoint exposure**: wrap the GraphQL endpoint directly via Gateway's outbound HTTP credential provider, or add thin tool-shaped Lambda adapters over it? The trade-off (whole-GraphQL-surface vs curated tool set, and whether the Gateway can hit API GW with Cognito inbound authorizer) becomes specifiable once #01's auth research lands.
- **Identity propagation / authorization fidelity**: whether per-user identity context flows from Gateway → Lambda target (the per-user isolation question), and if not, what compensating pattern is needed — becomes a ticket once #01 answers it as a fact.
- **ADR structure and location** (`docs/adr/NNNN-agentcore-gateway-mcp.md`): outline becomes specifiable once the verdict (#04) is in.

## Out of scope

- Shipping the actual Terraform code. Destination is the decision doc; the map ends when the ADR is written. (Wayfinder "plan, don't do" default.)
- Building the actual thin tool-shaped Lambda adapters for the GraphQL endpoint. Decision recorded if applicable; implementation is later work.
