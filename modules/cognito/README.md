# Cognito

Creates a resource server and a dedicated public OAuth client in an existing
Cognito user pool. This module can be used independently of `mcp-http-api`.

```hcl
module "cognito" {
  source        = "../../modules/cognito"
  name          = "bookings"
  user_pool_id  = var.user_pool_id
  mcp_url       = "https://mcp.example.com/mcp"
  callback_urls = ["https://agent.example.com/callback"]
}
```

The resource server defaults to the canonical MCP URL and exposes the configured
scope. The client uses authorization code with PKCE, token revocation, and refresh
token rotation. Password authentication remains opt-in for test sandboxes.

Outputs supply the issuer, client ID, resource-server identifier, and required
scope to the caller. The user pool, login domain, and managed-login branding remain
the caller's responsibility.

When composing with `mcp-http-api`, set this module's `mcp_url` to
`module.mcp.mcp_url` and set the MCP module's `cognito_authorization_server` to
`module.cognito.authorization_server`. See the
[complete composition and migration instructions](../mcp-http-api/README.md).

The required inputs are `name`, `user_pool_id`, `mcp_url`, and a nonempty
`callback_urls` list. Optional inputs are `logout_urls`, `scope_name` (default
`read`), `resource_server_identifier` (default `mcp_url`),
`allow_unbound_access_tokens`, and `enable_password_auth_for_tests` (both default
`false`). A custom identifier that differs from `mcp_url` requires explicit legacy
compatibility; enable the corresponding compatibility option on the MCP endpoint
as well.

Run this module's mocked tests:

```bash
terraform -chdir=modules/cognito init -backend=false
terraform -chdir=modules/cognito test
```
