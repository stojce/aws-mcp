mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mcp-test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/mcp-test" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend" }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = { id = "eu-west-1_example" }
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
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

mock_provider "archive" {}

run "hosted_and_unsloth_clients_use_public_cognito_endpoints_and_s256_discovery" {
  command = apply
  assert {
    condition = (
      contains(output.callback_urls, "https://claude.ai/api/mcp/auth_callback") &&
      contains(output.callback_urls, "https://mcptest.io/oauth/callback") &&
      contains(output.callback_urls, "http://localhost:6275/callback") &&
      contains(var.allowed_origins, "https://mcptest.io") &&
      alltrue([for callback in output.callback_urls : startswith(callback, "https://") || can(regex("^http://localhost:[0-9]+/callback$", callback))]) &&
      alltrue([for origin in var.allowed_origins : startswith(origin, "https://")]) &&
      !var.enable_password_auth_for_tests &&
      output.authorization_endpoint == output.cognito_authorization_endpoint &&
      output.token_endpoint == output.cognito_token_endpoint &&
      startswith(output.token_endpoint, "https://") &&
      output.oauth_authorization_server_issuer == "https://mcp.example.cloudfront.net" &&
      output.authorization_server_metadata_url == "https://mcp.example.cloudfront.net/.well-known/oauth-authorization-server" &&
      output.authorization_server_issuer == "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example"
    )
    error_message = "Hosted clients and Unsloth need registered callbacks, including Unsloth's fixed localhost:6275 port, with public S256 discovery while token verification trusts Cognito."
  }
}

run "public_oauth_override_keeps_separate_cognito_upstreams" {
  command = apply
  variables {
    oauth_proxy_endpoints = {
      authorization_endpoint = "https://auth.example.com/authorize"
      token_endpoint         = "https://auth.example.com/token"
    }
  }
  assert {
    condition = (
      output.authorization_endpoint == "https://auth.example.com/authorize" &&
      output.token_endpoint == "https://auth.example.com/token" &&
      startswith(output.cognito_authorization_endpoint, "https://") &&
      startswith(output.cognito_token_endpoint, "https://") &&
      output.oauth_authorization_server_issuer == "https://mcp.example.cloudfront.net" &&
      output.authorization_server_metadata_url == "https://mcp.example.cloudfront.net/.well-known/oauth-authorization-server"
    )
    error_message = "An HTTPS OAuth override must advertise its public endpoints while retaining the Cognito upstream outputs."
  }
}
