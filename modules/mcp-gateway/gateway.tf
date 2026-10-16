# ──────────────────────────────────────────────────────────────────────────────
# 1. Cognito: MCP resource server + dedicated MCP app client on the EXISTING pool
# ──────────────────────────────────────────────────────────────────────────────

# The resource server owns the mcp.* scopes. mcp.write is NOT created at v1:
# it is added when the first mutation tool is designed (its review checkpoint
# must exist before the scope is granted).
resource "aws_cognito_resource_server" "mcp" {
  identifier = local.scope_prefix
  name       = local.resource_server_name
  user_pool_id = var.user_pool_id

  scope {
    scope_name        = "read"
    scope_description = "Read-only access to the user's own bookings, subscriptions and memberships via MCP"
  }
}

# Dedicated app client. Its tokens are the ONLY ones the Gateway accepts:
# web-app tokens carry a different client_id and are rejected at the MCP edge
# even though both validate against the same pool.
resource "aws_cognito_user_pool_client" "mcp" {
  name         = local.client_name
  user_pool_id = var.user_pool_id

  # Confidential client, authorization-code + PKCE. No client_credentials sub
  # would be the client id, not the user — breaking per-user isolation.
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  # Scope reference must be the fully-qualified form (resource-server
  # identifier + scope name) Cognito issues in access tokens: "mcp/read".
  allowed_oauth_scopes                 = ["mcp/read"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]

  callback_urls = [var.web_client_callback_url]
  logout_urls   = [var.web_client_logout_url]

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  supported_identity_providers = ["COGNITO"]

  # The pool's user attributes suffice; every per-user authz fact (userId,
  # userRole, providerId, isAnonymous) resolves through the interceptor.
  read_attributes  = []
  write_attributes = []

  prevent_user_existence_errors = "ENABLED"
}

# ──────────────────────────────────────────────────────────────────────────────
# 2. Gateway execution role
# ──────────────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "gateway_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "gateway" {
  name               = "${local.gateway_name}-role"
  assume_role_policy = data.aws_iam_policy_document.gateway_assume.json
}

# lambda:InvokeFunction on exactly this module's target(s), nothing else.
data "aws_iam_policy_document" "invoke_targets" {
  count = (length(var.targets) > 0 || var.gateway_lambda_target_arn != null) ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["lambda:InvokeFunction"]
    resources = distinct(
      concat(
        var.gateway_lambda_target_arn != null ? [var.gateway_lambda_target_arn] : [],
        [for t in var.targets : t.lambda_arn],
        [aws_lambda_function.interceptor.arn]
      )
    )
  }
}

resource "aws_iam_role_policy" "invoke_targets" {
  count = (length(var.targets) > 0 || var.gateway_lambda_target_arn != null) ? 1 : 0

  name   = "invoke-targets"
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.invoke_targets[0].json
}

# ──────────────────────────────────────────────────────────────────────────────
# 3. Gateway (MCP protocol, CUSTOM_JWT against the existing pool)
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_bedrockagentcore_gateway" "this" {
  name        = local.gateway_name
  description = "MCP edge for ${var.name}: curated per-user reads over the existing API surface (ADR-0001)"
  role_arn    = aws_iam_role.gateway.arn

  authorizer_type = "CUSTOM_JWT"
  authorizer_configuration {
    custom_jwt_authorizer {
      # Cognito JIT discovery endpoint.
      discovery_url = "https://cognito-idp.${var.region}.amazonaws.com/${var.user_pool_id}/.well-known/openid-configuration"

      # Bind to the dedicated MCP app client ONLY. Web-app client tokens
      # cannot be replayed at the MCP edge.
      allowed_audience = [aws_cognito_user_pool_client.mcp.id]
      allowed_clients  = [aws_cognito_user_pool_client.mcp.id]
      allowed_scopes   = ["mcp/read"]
    }
  }

  protocol_type = "MCP"
  protocol_configuration {
    mcp {
      search_type = "SEMANTIC"
    }
  }

  # Request interceptor: decodes the validated inbound JWT (the Gateway's
  # CUSTOM_JWT authorizer verified the signature before this runs) and injects
  # the signed claims headers that the target's context guard verifies.
  # passRequestHeaders=true is REQUIRED: headers reach the interceptor only
  # when set (AWS interceptor docs).
  interceptor_configuration {
    interception_points = ["REQUEST"]

    interceptor {
      lambda {
        arn = aws_lambda_function.interceptor.arn
      }
    }

    input_configuration {
      pass_request_headers = true
    }
  }

  tags = {
    Name = local.gateway_name
  }
}
