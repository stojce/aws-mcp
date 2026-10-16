# Ticket 05: Grilling Terraform module contract: inputs, outputs, assumptions

Type: grilling
Status: resolved
Blocked by: 04

## Question

Settle the **module façade** as user decisions, informed by the verdict (#04). Grill on real choices a module consumer faces:

- Does the module create the **Cognito resources too** (resource server + scopes + app clients for MCP clients), or accept an existing User Pool and only wire the authorizer config?
- Does it create **Lambda targets** inline from a list of `{lambda_arn, tool_name, tool_schema}` vars, or does the consumer declare targets separately?
- Does it own the **outbound credential provider**, or accept a secret ARN?
- What does it **export** (gateway URL/ID, execution role ARN, tool names)?
- Account-level one-time setup (e.g. service-linked-ish roles, provider registrations that can only exist once) — accept input vs create with a `one_time = true` flag?

Recommend a façade; user confirms or edits. This ticket is the "interface as decision" deliverable for the map.

## Answer

<!-- filled on resolution -->
## Answer

Module façade decisions (round 3 grilling, all recommended options accepted):

- **Cognito ownership:** module creates **only the MCP app client and the MCP resource server/scopes** on the existing pool. Pool itself, web clients, etc. stay owned by `guryou-infra-terraform` (`modules/cognito`). Module inputs: pool id, region; NOT pool creation.
- **Gateway targets:** module owns `aws_bedrockagentcore_gateway_target` resources, driven by a variable list `targets: [{ name, lambda_arn, tool_name, tool_schema, credential_provider_arn? }]` — `credential_provider_arn` optional hook for later HTTP/OpenAPI targets, empty at v1.
- **Outbound credential providers:** **skipped at v1** (Lambda targets need none); the variable hook above is the seam for the later pivot.
- **Outputs:** gateway endpoint URL, gateway id, gateway execution role ARN, MCP app client id, tool names.
- **No `one_time` flag:** module always owns the gateway execution role and the `lambda:InvokeFunction` permission wiring for its targets.

Consequences for the ADR's Terraform section: `variable "targets"` is the module's tool surface; resource server + app client + gateway + gateway targets + role are the five resource groups; zero manual post-apply steps required.
