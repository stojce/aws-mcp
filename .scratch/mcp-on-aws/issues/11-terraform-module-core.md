# Ticket 11: Terraform module core: MCP app client, resource server, Gateway

**What to build:** applying the module in a dev environment produces a world-facing **Gateway** that authenticates only the dedicated **MCP app client**: the module creates the app client and the MCP resource server with `mcp.read` on the existing User Pool (pool id + region as inputs), the Gateway itself with `CUSTOM_JWT` inbound authorizer against the pool's OIDC discovery URL, the Gateway execution role, and the module outputs (Gateway endpoint URL, gateway id, role ARN, MCP app client id, tool names). `targets` starts empty. No manual post-apply steps.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Module inputs: pool id, region; module does not create the User Pool.
- [ ] Resource server exposes `mcp.read` only; no `mcp.write`, no `client_credentials` grant on the MCP app client.
- [ ] Gateway `allowed_audience`/`allowed_clients` binds to the MCP app client only; `allowed_scopes = ["mcp.read"]`.
- [ ] Execution role + `targets` variable list (`name`, `lambda_arn`, `tool_name`, `tool_schema`, optional `credential_provider_arn` hook) present; zero targets at this stage.
- [ ] Required module outputs resolve after apply (endpoint URL, gateway id, role ARN, app client id, tool names).
- [ ] Provider constraint enforced: `hashicorp/aws` ≥ 6.21.0 (prefer ≥ 6.34.0).
- [ ] Verified by real apply in dev: outputs non-empty; Gateway exists in eu-west-1.
