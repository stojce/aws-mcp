# Native HTTP API JWT failures bypass integrations and cannot be decorated with
# integration response mappings. CloudFront adds discovery to the advertised
# endpoint's responses, including those 401s, without changing the JWT boundary.
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Forward Authorization and all MCP headers; API Gateway needs its own Host.
data "aws_cloudfront_origin_request_policy" "api_gateway" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_response_headers_policy" "discovery" {
  name = "${var.name}-mcp-discovery"

  # Native JWT failures bypass the Lambda. Add CORS at the advertised endpoint
  # too, so trusted browser clients can read the OAuth discovery challenge.
  dynamic "cors_config" {
    for_each = length(var.allowed_origins) > 0 ? [1] : []
    content {
      access_control_allow_credentials = false
      origin_override                  = true
      access_control_max_age_sec       = 300
      access_control_allow_origins {
        items = sort(tolist(var.allowed_origins))
      }
      access_control_allow_methods {
        items = local.cors_methods
      }
      access_control_allow_headers {
        items = local.cors_request_headers
      }
      access_control_expose_headers {
        items = local.cors_expose_headers
      }
    }
  }

  custom_headers_config {
    items {
      header = "WWW-Authenticate"
      # The metadata advertises scopes. Including the URL-derived scope here
      # would make this policy depend on its own CloudFront distribution.
      value    = "Bearer resource_metadata=\"${local.resource_metadata_url}\""
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "mcp" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} MCP OAuth discovery and native JWT endpoint"

  origin {
    domain_name = trimprefix(aws_apigatewayv2_api.mcp.api_endpoint, "https://")
    origin_id   = "mcp-http-api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "mcp-http-api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.api_gateway.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.discovery.id
  }

  # CachingDisabled controls successful responses. Disable error caching too so
  # a denial or transient failure cannot be replayed to a different caller.
  dynamic "custom_error_response" {
    for_each = toset([403, 404, 405, 500, 502, 503, 504])
    content {
      error_code            = custom_error_response.value
      error_caching_min_ttl = 0
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
