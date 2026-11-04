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
    defaults = {
      domain_name = "mcp.example.cloudfront.net"
    }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
}

mock_provider "archive" {}

variables {
  name             = "mcp-oauth-test"
  user_pool_id     = "eu-west-1_example"
  tool_backend_arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend"
  server_name      = "oauth-test"
  callback_urls    = ["http://localhost:8080/callback"]
  tools            = []
}

run "resource_bound_discovery" {
  command = apply

  assert {
    condition     = aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].audience == toset([output.mcp_url])
    error_message = "The edge must require the canonical MCP resource audience by default."
  }

  assert {
    condition     = aws_apigatewayv2_route.mcp.authorization_type == "JWT" && aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope])
    error_message = "Adding discovery must preserve native JWT and scope enforcement on MCP calls."
  }

  assert {
    condition     = alltrue([for route in aws_apigatewayv2_route.resource_metadata : route.authorization_type == "NONE"])
    error_message = "Both protected-resource metadata paths must be readable before login."
  }

  assert {
    condition = (
      one(aws_cloudfront_response_headers_policy.discovery.custom_headers_config[0].items).override &&
      one(aws_cloudfront_response_headers_policy.discovery.custom_headers_config[0].items).value == "Bearer resource_metadata=\"${output.resource_metadata_url}\"" &&
      aws_cloudfront_distribution.mcp.default_cache_behavior[0].response_headers_policy_id == aws_cloudfront_response_headers_policy.discovery.id
    )
    error_message = "The advertised endpoint must add discoverable metadata to native authorizer failures."
  }

  assert {
    condition = (
      aws_cloudfront_distribution.mcp.default_cache_behavior[0].cache_policy_id == data.aws_cloudfront_cache_policy.disabled.id &&
      aws_cloudfront_distribution.mcp.default_cache_behavior[0].origin_request_policy_id == data.aws_cloudfront_origin_request_policy.api_gateway.id &&
      alltrue([for response in aws_cloudfront_distribution.mcp.custom_error_response : response.error_caching_min_ttl == 0])
    )
    error_message = "MCP requests must forward bearer credentials without sharing cached results or denials."
  }
}

run "explicit_legacy_compatibility" {
  command = apply

  variables {
    allow_unbound_access_tokens = true
  }

  assert {
    condition = aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].audience == toset([
      output.mcp_url, output.mcp_app_client_id,
    ])
    error_message = "Legacy compatibility must add client_id fallback without dropping resource binding."
  }
}
