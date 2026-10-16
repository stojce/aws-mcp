# Ticket 05: Grilling Terraform module contract: inputs, outputs, assumptions

Type: grilling
Status: open
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
