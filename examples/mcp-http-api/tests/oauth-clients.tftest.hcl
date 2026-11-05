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

run "hosted_clients_use_public_cognito_endpoints_and_s256_discovery" {
  command = apply
  assert {
    condition = (
      contains(output.callback_urls, "https://claude.ai/api/mcp/auth_callback") &&
      contains(output.callback_urls, "https://mcptest.io/oauth/callback") &&
      contains(var.allowed_origins, "https://mcptest.io") &&
      output.authorization_endpoint == output.cognito_authorization_endpoint &&
      output.token_endpoint == output.cognito_token_endpoint &&
      startswith(output.token_endpoint, "https://") &&
      output.oauth_authorization_server_issuer == "https://mcp.example.cloudfront.net" &&
      output.authorization_server_metadata_url == "https://mcp.example.cloudfront.net/.well-known/oauth-authorization-server" &&
      output.authorization_server_issuer == "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example"
    )
    error_message = "Hosted clients need registered callbacks, direct browser access for mcptest, and public S256 discovery while token verification trusts Cognito."
  }
}

run "local_proxy_remains_opt_in_with_separate_cognito_upstreams" {
  command = apply
  variables {
    oauth_proxy_endpoints = {
      authorization_endpoint = "http://localhost:8080/authorize"
      token_endpoint         = "http://localhost:8080/token"
    }
  }
  assert {
    condition = (
      output.authorization_endpoint == "http://localhost:8080/authorize" &&
      output.token_endpoint == "http://localhost:8080/token" &&
      startswith(output.cognito_authorization_endpoint, "https://") &&
      startswith(output.cognito_token_endpoint, "https://") &&
      output.oauth_authorization_server_issuer == "https://mcp.example.cloudfront.net" &&
      output.authorization_server_metadata_url == "https://mcp.example.cloudfront.net/.well-known/oauth-authorization-server"
    )
    error_message = "The local option must advertise the requested helper endpoints without using them as its Cognito upstreams."
  }
}
