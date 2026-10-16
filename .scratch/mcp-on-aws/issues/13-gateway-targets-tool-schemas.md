# Ticket 13: Gateway targets: verified tools, hand-derived toolSchema, interceptor attached

Type: task
Status: resolved

## Answer

- `targets.tf`: `aws_bedrockagentcore_gateway_target.lambda_targets` (for_each over `var.targets`), Lambda MCP type, `credential_provider_configuration { gateway_iam_role {} }` (reserved hook shape kept unused at v1), `tool_schema.inline_payload` with name/description/input_schema/output_schema derived from the per-target JSON schemas; `depends_on` the invoke policy.
- `examples/customer-assistant/main.tf`: the **v1 verified tool list** from ticket 10 with hand-derived toolSchemas:
  - `get_my_booked_events` — input `startTime?: string` (LenientDateTime-compatible), output `events: [...]` with the BookingEvent answer-fields (id, name, startTime, endTime, type, entityType, serviceName, location, status).
  - `get_my_memberships` — input `all?: boolean`, output `memberships: [...]` (id, name, type, isActive, validity, counters, providerName).
- Invoke permissions: gateway role policy is the distinct set of {graphql Lambda ARN, target ARNs, interceptor ARN}.
- Interceptor attached to the Gateway (see ticket 12).

## Verification

- `terraform validate` passes for the full example wiring (targets + schemas + interceptor + permissions).
- Live `_ListTools` not exercised (offline choice on ticket 11); the tool names are exactly the curated list and the schemas compile — live check rolls into ticket 15's smoke run.

## Acceptance criteria

- [x] Targets from verified list only; schemas derived from captured GraphQL types.
- [x] Interceptor wired; claims reach the invocation path (configuration-level).
- [x] Invoke permissions scoped to needed Lambdas only.
- [x] Credential-provider hook reserved/empty.
- [ ] Tools listed through the live edge (pending offline→apply).
