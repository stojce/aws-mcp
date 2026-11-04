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
  name             = "mcp-external-test"
  tool_backend_arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend"
  server_name      = "external-test"
  tools            = []
  external_authorization_server = {
    issuer         = "https://identity.example.com/realms/app"
    client_id      = "mcp-client"
    required_scope = "bookings:read"
  }
}

run "external_server_replaces_cognito_configuration" {
  command = apply
  assert {
    condition = (
      length(aws_cognito_resource_server.mcp) == 0 &&
      length(aws_cognito_user_pool_client.mcp) == 0 &&
      output.authorization_mode == "external" &&
      output.mcp_resource_server_identifier == null &&
      output.authorization_server_issuer == var.external_authorization_server.issuer &&
      output.mcp_app_client_id == var.external_authorization_server.client_id &&
      output.required_scope == var.external_authorization_server.required_scope &&
      output.client_id_claim == "client_id"
    )
    error_message = "External auth must use the supplied issuer, client, and scope without creating Cognito resources or requiring callback URLs."
  }
  assert {
    condition = (
      aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].issuer == var.external_authorization_server.issuer &&
      aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].audience == toset([output.mcp_url]) &&
      aws_apigatewayv2_route.mcp.authorization_type == "JWT" &&
      aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope]) &&
      alltrue([for route in aws_apigatewayv2_route.resource_metadata : route.authorization_type == "NONE"]) &&
      aws_lambda_function.mcp.environment[0].variables.MCP_AUTHORIZATION_SERVER == output.authorization_server_issuer &&
      aws_lambda_function.mcp.environment[0].variables.MCP_AUTHORIZATION_MODE == "external" &&
      aws_lambda_function.mcp.environment[0].variables.MCP_CLIENT_ID == output.mcp_app_client_id &&
      aws_lambda_function.mcp.environment[0].variables.MCP_CLIENT_ID_CLAIM == "client_id" &&
      aws_lambda_function.mcp.environment[0].variables.MCP_REQUIRED_SCOPE == output.required_scope &&
      aws_lambda_function.mcp.environment[0].variables.MCP_ACCESS_TOKEN_CLAIM == "null"
    )
    error_message = "The native JWT boundary, public discovery, and runtime must agree on the external issuer, client, scope, and strict resource audience."
  }
}

run "external_client_and_token_markers_reach_the_runtime" {
  command = apply
  variables {
    external_authorization_server = {
      issuer          = "https://identity.example.com/realms/app"
      client_id       = "mcp-client"
      required_scope  = "bookings:read"
      client_id_claim = "azp"
      access_token_claim = {
        name  = "kind"
        value = "access"
      }
    }
  }
  assert {
    condition = (
      output.client_id_claim == "azp" &&
      aws_lambda_function.mcp.environment[0].variables.MCP_CLIENT_ID_CLAIM == "azp" &&
      jsondecode(aws_lambda_function.mcp.environment[0].variables.MCP_ACCESS_TOKEN_CLAIM) == var.external_authorization_server.access_token_claim
    )
    error_message = "Provider-specific client and access-token claims must be enforced by the Lambda."
  }
}

run "external_auth_rejects_unbound_token_compatibility" {
  command = plan
  variables { allow_unbound_access_tokens = true }
  expect_failures = [var.allow_unbound_access_tokens]
}

run "both_authorization_modes_are_rejected" {
  command = plan
  variables { user_pool_id = "eu-west-1_example" }
  expect_failures = [var.user_pool_id]
}

run "an_authorization_server_is_required" {
  command = plan
  variables {
    external_authorization_server = null
    callback_urls                 = ["http://localhost:8080/callback"]
  }
  expect_failures = [var.user_pool_id]
}

run "insecure_external_issuer_is_rejected" {
  command = plan
  variables {
    external_authorization_server = {
      issuer         = "http://identity.example.com"
      client_id      = "mcp-client"
      required_scope = "bookings:read"
    }
  }
  expect_failures = [var.external_authorization_server]
}

run "external_scope_must_be_one_oauth_scope" {
  command = plan
  variables {
    external_authorization_server = {
      issuer         = "https://identity.example.com"
      client_id      = "mcp-client"
      required_scope = "bookings:read other"
    }
  }
  expect_failures = [var.external_authorization_server]
}

run "external_client_claim_must_be_configured" {
  command = plan
  variables {
    external_authorization_server = {
      issuer          = "https://identity.example.com"
      client_id       = "mcp-client"
      required_scope  = "bookings:read"
      client_id_claim = ""
    }
  }
  expect_failures = [var.external_authorization_server]
}
