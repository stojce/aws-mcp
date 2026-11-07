# ──────────────────────────────────────────────────────────────────────────────
# 1. MCP Lambda: code + generated tools manifest packaged together
# ──────────────────────────────────────────────────────────────────────────────

locals {
  mcp_server_sources = {
    "tools.json"                   = local.tools_manifest
    "index.mjs"                    = file("${path.module}/lambda/mcp-server/index.mjs")
    "runtime.mjs"                  = file("${path.module}/lambda/mcp-server/runtime.mjs")
    "schema-validator.mjs"         = file("${path.module}/lambda/mcp-server/schema-validator.mjs")
    "schema-validator.LICENSE.txt" = file("${path.module}/lambda/mcp-server/schema-validator.LICENSE.txt")
  }
}

data "archive_file" "mcp_server" {
  type = "zip"
  # Local module instances share path.module. Keep builds in the root's ignored
  # directory, and retain earlier packages for saved plans when inputs change.
  output_path = "${path.root}/.terraform/mcp-http-api/${var.name}-${sha256(jsonencode(local.mcp_server_sources))}.zip"

  dynamic "source" {
    for_each = local.mcp_server_sources
    content {
      content  = source.value
      filename = source.key
    }
  }
}

resource "aws_iam_role" "mcp" {
  name = "${var.name}-mcp-server"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "mcp_logs" {
  role       = aws_iam_role.mcp.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "invoke_backend" {
  name = "invoke-tool-backend"
  role = aws_iam_role.mcp.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = var.tool_backend_arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/aws/lambda/${var.name}-mcp-server"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "mcp" {
  function_name    = "${var.name}-mcp-server"
  role             = aws_iam_role.mcp.arn
  runtime          = "nodejs26.x"
  handler          = "index.handler"
  filename         = data.archive_file.mcp_server.output_path
  source_code_hash = data.archive_file.mcp_server.output_base64sha256
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_s

  environment {
    variables = {
      MCP_CLIENT_ID                     = local.mcp_client_id
      MCP_REQUIRED_SCOPE                = local.full_scope
      MCP_RESOURCE_URL                  = local.mcp_url
      MCP_RESOURCE_METADATA_URL         = local.resource_metadata_url
      MCP_AUTHORIZATION_SERVER          = local.oauth_discovery_issuer
      MCP_AUTHORIZATION_SERVER_METADATA = jsonencode(local.oauth_server_metadata)
      MCP_AUTHORIZATION_MODE            = local.authorization_mode
      MCP_CLIENT_ID_CLAIM               = local.client_id_claim
      MCP_ACCESS_TOKEN_CLAIM            = jsonencode(local.access_token_claim)
      MCP_ALLOW_UNBOUND_ACCESS_TOKENS   = tostring(var.allow_unbound_access_tokens)
      MCP_ALLOWED_ORIGINS               = jsonencode(sort(tolist(var.allowed_origins)))
      MCP_TOOL_TIMEOUT_MS               = tostring(local.tool_timeout_ms)
      TOOL_BACKEND_ARN                  = var.tool_backend_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.mcp, aws_iam_role_policy_attachment.mcp_logs]
}

# ──────────────────────────────────────────────────────────────────────────────
# 2. HTTP API: /mcp guarded by the native JWT authorizer (scope check at edge)
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_api" "mcp" {
  name          = "${var.name}-mcp"
  protocol_type = "HTTP"

  dynamic "cors_configuration" {
    for_each = length(var.allowed_origins) > 0 ? [1] : []
    content {
      allow_origins     = sort(tolist(var.allowed_origins))
      allow_methods     = local.cors_methods
      allow_headers     = local.cors_request_headers
      expose_headers    = local.cors_expose_headers
      allow_credentials = false
      max_age           = 300
    }
  }
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.mcp.id
  name             = var.external_authorization_server == null ? "cognito-mcp-client" : "external-mcp-client"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer = local.authorization_issuer
    # Tokens bind aud to the canonical MCP URI. API Gateway checks client_id
    # only when aud is absent; the runtime pins the configured client claim.
    audience = concat(
      [local.mcp_url],
      var.allow_unbound_access_tokens ? [local.mcp_client_id] : []
    )
  }
}

resource "aws_apigatewayv2_integration" "mcp" {
  api_id                 = aws_apigatewayv2_api.mcp.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.mcp.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = local.integration_timeout_ms
}

# ANY lets the Lambda own method policy. Browser preflight has separate public
# routes; all ordinary MCP methods still require JWT and the MCP scope.
resource "aws_apigatewayv2_route" "mcp" {
  api_id               = aws_apigatewayv2_api.mcp.id
  route_key            = "ANY /mcp"
  target               = "integrations/${aws_apigatewayv2_integration.mcp.id}"
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.jwt.id
  authorization_scopes = [local.full_scope]
}

# Discovery must be readable before the client has an access token.
resource "aws_apigatewayv2_route" "resource_metadata" {
  for_each = toset([
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-protected-resource",
  ])

  api_id             = aws_apigatewayv2_api.mcp.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.mcp.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "authorization_server_metadata" {
  count = var.oauth_proxy_endpoints == null ? 0 : 1

  api_id             = aws_apigatewayv2_api.mcp.id
  route_key          = "GET /.well-known/oauth-authorization-server"
  target             = "integrations/${aws_apigatewayv2_integration.mcp.id}"
  authorization_type = "NONE"
}

# Explicit method routes take priority over ANY /mcp so preflight never needs a
# bearer token. API Gateway handles CORS; the Lambda enforces the same policy.
resource "aws_apigatewayv2_route" "preflight" {
  for_each = length(var.allowed_origins) > 0 ? toset(concat([
    "OPTIONS /mcp",
    "OPTIONS /.well-known/oauth-protected-resource/mcp",
    "OPTIONS /.well-known/oauth-protected-resource",
  ], var.oauth_proxy_endpoints == null ? [] : ["OPTIONS /.well-known/oauth-authorization-server"])) : toset([])

  api_id             = aws_apigatewayv2_api.mcp.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.mcp.id}"
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${var.name}-mcp"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.mcp.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      integrationErr = "$context.integrationErrorMessage"
      authError      = "$context.authorizer.error"
      sub            = "$context.authorizer.claims.sub"
    })
  }
}

resource "aws_lambda_permission" "apigw_invoke_mcp" {
  statement_id  = "AllowHttpApiInvokeMcp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mcp.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.mcp.execution_arn}/*/*"
}
