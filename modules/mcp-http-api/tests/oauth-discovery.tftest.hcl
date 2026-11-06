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
  name = "mcp-oauth-test"
  cognito_authorization_server = {
    issuer                     = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example"
    client_id                  = "mcp-client"
    required_scope             = "https://mcp.example.cloudfront.net/mcp/read"
    resource_server_identifier = "https://mcp.example.cloudfront.net/mcp"
  }
  tool_backend_arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend"
  server_name      = "oauth-test"
  tools            = []
}

run "resource_bound_discovery" {
  command = apply

  assert {
    condition = (
      output.oauth_authorization_server_issuer == output.authorization_server_issuer &&
      output.authorization_server_metadata_url == null &&
      length(aws_apigatewayv2_route.authorization_server_metadata) == 0 &&
      aws_lambda_function.mcp.environment[0].variables.MCP_AUTHORIZATION_SERVER_METADATA == "null"
    )
    error_message = "Default discovery must continue to use the original issuer without a proxy metadata route."
  }

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

run "public_oauth_endpoints_are_environment_configured_and_keep_cognito_verification" {
  command = apply

  variables {
    allowed_origins = ["https://client.example.com"]
    oauth_proxy_endpoints = {
      authorization_endpoint = "https://example.auth.eu-west-1.amazoncognito.com/oauth2/authorize"
      token_endpoint         = "https://example.auth.eu-west-1.amazoncognito.com/oauth2/token"
    }
  }

  assert {
    condition = (
      output.oauth_authorization_server_issuer == "https://mcp.example.cloudfront.net" &&
      output.authorization_server_metadata_url == "https://mcp.example.cloudfront.net/.well-known/oauth-authorization-server" &&
      aws_lambda_function.mcp.environment[0].variables.MCP_AUTHORIZATION_SERVER == output.oauth_authorization_server_issuer &&
      jsondecode(aws_lambda_function.mcp.environment[0].variables.MCP_AUTHORIZATION_SERVER_METADATA) == {
        issuer                                = output.oauth_authorization_server_issuer
        authorization_endpoint                = "https://example.auth.eu-west-1.amazoncognito.com/oauth2/authorize"
        token_endpoint                        = "https://example.auth.eu-west-1.amazoncognito.com/oauth2/token"
        response_types_supported              = ["code"]
        grant_types_supported                 = ["authorization_code", "refresh_token"]
        token_endpoint_auth_methods_supported = ["none"]
        code_challenge_methods_supported      = ["S256"]
        client_id_metadata_document_supported = false
        scopes_supported                      = ["openid", "email", output.required_scope]
      }
    )
    error_message = "The Lambda environment must supply public Cognito endpoints and PKCE capabilities under a matching HTTPS metadata issuer."
  }

  assert {
    condition = (
      aws_apigatewayv2_route.authorization_server_metadata[0].route_key == "GET /.well-known/oauth-authorization-server" &&
      aws_apigatewayv2_route.authorization_server_metadata[0].authorization_type == "NONE" &&
      aws_apigatewayv2_route.preflight["OPTIONS /.well-known/oauth-authorization-server"].authorization_type == "NONE" &&
      aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].issuer == "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example" &&
      output.authorization_server_issuer == aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].issuer &&
      aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].audience == toset([output.mcp_url]) &&
      aws_apigatewayv2_route.mcp.authorization_type == "JWT" &&
      aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope])
    )
    error_message = "Only discovery is public; the edge must still verify Cognito tokens, resource audience, and the required scope."
  }
}

run "localhost_oauth_endpoints_are_rejected" {
  command = plan
  variables {
    oauth_proxy_endpoints = {
      authorization_endpoint = "http://localhost:8080/authorize"
      token_endpoint         = "http://localhost:8080/token"
    }
  }
  expect_failures = [var.oauth_proxy_endpoints]
}

run "https_loopback_oauth_endpoints_are_rejected" {
  command = plan
  variables {
    oauth_proxy_endpoints = {
      authorization_endpoint = "https://localhost:8080/authorize"
      token_endpoint         = "https://127.0.0.1:8080/token"
    }
  }
  expect_failures = [var.oauth_proxy_endpoints]
}

run "http_proxy_is_rejected" {
  command = plan
  variables {
    oauth_proxy_endpoints = {
      authorization_endpoint = "http://proxy.example.com/authorize"
      token_endpoint         = "http://proxy.example.com/token"
    }
  }
  expect_failures = [var.oauth_proxy_endpoints]
}

run "proxy_endpoints_with_credentials_are_rejected" {
  command = plan
  variables {
    oauth_proxy_endpoints = {
      authorization_endpoint = "https://user@proxy.example.com/authorize"
      token_endpoint         = "https://proxy.example.com/token"
    }
  }
  expect_failures = [var.oauth_proxy_endpoints]
}
