mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mcp-test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/mcp-test" }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      api_endpoint  = "https://api.example.com"
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:testapi"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { domain_name = "mcp.example.cloudfront.net" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
}

mock_provider "archive" {}

variables {
  name             = "mcp-http-test"
  user_pool_id     = "eu-west-1_example"
  tool_backend_arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend"
  server_name      = "http-test"
  callback_urls    = ["http://localhost:8080/callback"]
  tools            = []
}

run "public_client_rotates_refresh_tokens" {
  command = apply

  assert {
    condition = (
      !aws_cognito_user_pool_client.mcp.generate_secret &&
      aws_cognito_user_pool_client.mcp.enable_token_revocation &&
      length(aws_cognito_user_pool_client.mcp.refresh_token_rotation) == 1 &&
      try(aws_cognito_user_pool_client.mcp.refresh_token_rotation[0].feature, "") == "ENABLED" &&
      try(aws_cognito_user_pool_client.mcp.refresh_token_rotation[0].retry_grace_period_seconds, -1) == 5 &&
      !contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_REFRESH_TOKEN_AUTH") &&
      !contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_USER_PASSWORD_AUTH")
    )
    error_message = "The public OAuth client must rotate refresh tokens without re-enabling password or legacy refresh authentication."
  }
}

run "sandbox_password_auth_keeps_rotation" {
  command = apply
  variables {
    enable_password_auth_for_tests = true
  }
  assert {
    condition = (
      contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_USER_PASSWORD_AUTH") &&
      !contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_REFRESH_TOKEN_AUTH") &&
      try(aws_cognito_user_pool_client.mcp.refresh_token_rotation[0].feature, "") == "ENABLED"
    )
    error_message = "Test password authentication must remain opt-in and compatible with refresh-token rotation."
  }
}

run "native_defaults_keep_browser_access_closed" {
  command = apply
  assert {
    condition = (
      length(aws_apigatewayv2_api.mcp.cors_configuration) == 0 &&
      length(aws_cloudfront_response_headers_policy.discovery.cors_config) == 0 &&
      length(aws_apigatewayv2_route.preflight) == 0 &&
      aws_lambda_function.mcp.environment[0].variables.MCP_ALLOWED_ORIGINS == "[]" &&
      aws_lambda_function.mcp.environment[0].variables.MCP_TOOL_TIMEOUT_MS == "27000" &&
      aws_apigatewayv2_integration.mcp.timeout_milliseconds == 28000 &&
      aws_apigatewayv2_route.mcp.authorization_type == "JWT"
    )
    error_message = "Native-client defaults must preserve JWT authorization and deadlines while denying supplied browser Origins."
  }
}

run "browser_origins_reach_cors_and_origin_validation" {
  command = apply
  variables {
    allowed_origins = ["https://app.example.com", "http://localhost:8080", "http://[::1]:8080"]
  }
  assert {
    condition = (
      aws_apigatewayv2_api.mcp.cors_configuration[0].allow_origins == var.allowed_origins &&
      aws_apigatewayv2_api.mcp.cors_configuration[0].allow_methods == toset(["GET", "POST", "OPTIONS"]) &&
      aws_apigatewayv2_api.mcp.cors_configuration[0].allow_headers == toset(["authorization", "content-type", "mcp-protocol-version", "accept"]) &&
      aws_apigatewayv2_api.mcp.cors_configuration[0].expose_headers == toset(["WWW-Authenticate"]) &&
      !aws_apigatewayv2_api.mcp.cors_configuration[0].allow_credentials &&
      aws_lambda_function.mcp.environment[0].variables.MCP_ALLOWED_ORIGINS == jsonencode(sort(tolist(var.allowed_origins)))
    )
    error_message = "API CORS and Lambda Origin validation must use the same explicit allowlist and permit required MCP headers."
  }
  assert {
    condition = (
      aws_cloudfront_response_headers_policy.discovery.cors_config[0].access_control_allow_origins[0].items == var.allowed_origins &&
      aws_cloudfront_response_headers_policy.discovery.cors_config[0].access_control_allow_methods[0].items == aws_apigatewayv2_api.mcp.cors_configuration[0].allow_methods &&
      aws_cloudfront_response_headers_policy.discovery.cors_config[0].access_control_allow_headers[0].items == aws_apigatewayv2_api.mcp.cors_configuration[0].allow_headers &&
      aws_cloudfront_response_headers_policy.discovery.cors_config[0].access_control_expose_headers[0].items == toset(["WWW-Authenticate"]) &&
      aws_cloudfront_response_headers_policy.discovery.cors_config[0].origin_override &&
      !aws_cloudfront_response_headers_policy.discovery.cors_config[0].access_control_allow_credentials
    )
    error_message = "The advertised CloudFront endpoint must expose discovery challenges to the same trusted origins even on native JWT failures."
  }
  assert {
    condition = (
      toset(keys(aws_apigatewayv2_route.preflight)) == toset([
        "OPTIONS /mcp", "OPTIONS /.well-known/oauth-protected-resource/mcp", "OPTIONS /.well-known/oauth-protected-resource",
      ]) &&
      alltrue([for route in aws_apigatewayv2_route.preflight : route.authorization_type == "NONE" && route.target == "integrations/${aws_apigatewayv2_integration.mcp.id}"]) &&
      aws_apigatewayv2_route.mcp.authorization_type == "JWT" &&
      aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope]) &&
      aws_apigatewayv2_authorizer.cognito.jwt_configuration[0].audience == toset([output.mcp_url])
    )
    error_message = "Only preflight and metadata may be public; browser support must preserve the MCP JWT scope and resource audience."
  }
}

run "minimum_timeout_has_valid_deadlines" {
  command = apply
  variables {
    lambda_timeout_s = 3
  }
  assert {
    condition = (
      aws_lambda_function.mcp.timeout == 3 &&
      aws_apigatewayv2_integration.mcp.timeout_milliseconds == 2000 &&
      try(aws_lambda_function.mcp.environment[0].variables.MCP_TOOL_TIMEOUT_MS, "") == "1000"
    )
    error_message = "The minimum deadline must leave one second for the backend and one second for the HTTP response."
  }
}

run "maximum_timeout_uses_http_api_quota" {
  command = apply
  variables {
    lambda_timeout_s = 31
  }
  assert {
    condition = (
      aws_lambda_function.mcp.timeout == 31 &&
      aws_apigatewayv2_integration.mcp.timeout_milliseconds == 30000 &&
      try(aws_lambda_function.mcp.environment[0].variables.MCP_TOOL_TIMEOUT_MS, "") == "29000"
    )
    error_message = "The largest supported timeout must respect the HTTP API 30-second integration limit."
  }
}

run "one_second_timeout_is_rejected" {
  command = plan
  variables {
    lambda_timeout_s = 1
  }
  expect_failures = [var.lambda_timeout_s]
}

run "insufficient_response_budget_is_rejected" {
  command = plan
  variables {
    lambda_timeout_s = 2
  }
  expect_failures = [var.lambda_timeout_s]
}

run "above_maximum_timeout_is_rejected" {
  command = plan
  variables {
    lambda_timeout_s = 32
  }
  expect_failures = [var.lambda_timeout_s]
}

run "review_timeout_is_rejected" {
  command = plan
  variables {
    lambda_timeout_s = 60
  }
  expect_failures = [var.lambda_timeout_s]
}

run "fractional_timeout_is_rejected" {
  command = plan
  variables {
    lambda_timeout_s = 3.5
  }
  expect_failures = [var.lambda_timeout_s]
}

run "wildcard_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["*"] }
  expect_failures = [var.allowed_origins]
}

run "pattern_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["https://*.example.com"] }
  expect_failures = [var.allowed_origins]
}

run "path_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["https://app.example.com/callback"] }
  expect_failures = [var.allowed_origins]
}

run "credentials_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["https://user@app.example.com"] }
  expect_failures = [var.allowed_origins]
}

run "opaque_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["null"] }
  expect_failures = [var.allowed_origins]
}

run "unsupported_scheme_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["ftp://app.example.com"] }
  expect_failures = [var.allowed_origins]
}

run "out_of_range_port_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["https://app.example.com:65536"] }
  expect_failures = [var.allowed_origins]
}

run "default_port_origin_is_rejected" {
  command = plan
  variables { allowed_origins = ["https://app.example.com:443"] }
  expect_failures = [var.allowed_origins]
}
