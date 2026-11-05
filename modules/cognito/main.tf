data "aws_region" "current" {}

locals {
  resource_server_identifier = var.resource_server_identifier == null ? var.mcp_url : var.resource_server_identifier
  full_scope                 = "${local.resource_server_identifier}/${var.scope_name}"
}

resource "aws_cognito_resource_server" "mcp" {
  identifier   = local.resource_server_identifier
  name         = "${var.name}-mcp"
  user_pool_id = var.user_pool_id

  scope {
    scope_name        = var.scope_name
    scope_description = "Read-only MCP access for the signed-in user"
  }

  lifecycle {
    # Migrate the client's scopes before deleting a previous resource server.
    create_before_destroy = true

    precondition {
      condition     = var.allow_unbound_access_tokens || local.resource_server_identifier == var.mcp_url
      error_message = "Resource-bound Cognito scopes must belong to mcp_url. Leave resource_server_identifier unset, or enable explicit legacy compatibility for a different identifier."
    }
  }
}

resource "aws_cognito_user_pool_client" "mcp" {
  name         = "${var.name}-mcp-client"
  user_pool_id = var.user_pool_id

  # Scope propagation is asynchronous; without this the client create can fail
  # with ScopeDoesNotExistException.
  depends_on = [aws_cognito_resource_server.mcp]

  # Public client + PKCE: the agent runs on the user's machine or in a browser.
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", local.full_scope]
  supported_identity_providers         = ["COGNITO"]
  # Keep a non-empty explicit set: Cognito's default includes the refresh flow
  # that is incompatible with rotation. API sign-in does not grant MCP scopes.
  explicit_auth_flows = concat(
    ["ALLOW_USER_SRP_AUTH"],
    var.enable_password_auth_for_tests ? ["ALLOW_USER_PASSWORD_AUTH"] : []
  )
  enable_token_revocation = true

  refresh_token_rotation {
    feature                    = "ENABLED"
    retry_grace_period_seconds = 5
  }

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
}
