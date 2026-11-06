variable "name" {
  description = "Short name used in every resource name."
  type        = string
}

variable "cognito_authorization_server" {
  description = "Existing Cognito issuer, public client, and scope. Pass module.cognito.authorization_server from the separately provisioned Cognito module, or configure external_authorization_server instead."
  type = object({
    issuer                     = string
    client_id                  = string
    required_scope             = string
    resource_server_identifier = string
  })
  default = null

  validation {
    condition = var.external_authorization_server != null ? var.cognito_authorization_server == null : (
      var.cognito_authorization_server == null ? false : (
        can(regex("^https://[^/?#@\\s]+(/[^?#\\s]*)?$", var.cognito_authorization_server.issuer)) &&
        try(trimspace(var.cognito_authorization_server.client_id) != "", false) &&
        can(regex("^[\\x21\\x23-\\x5B\\x5D-\\x7E]+$", var.cognito_authorization_server.required_scope)) &&
        try(trimspace(var.cognito_authorization_server.resource_server_identifier) != "", false)
      )
    )
    error_message = "Configure exactly one of cognito_authorization_server or external_authorization_server. Cognito requires an HTTPS issuer, nonempty client ID and resource-server identifier, and one valid OAuth scope."
  }
}

variable "external_authorization_server" {
  description = "Existing OAuth/OIDC JWT authorization server and public MCP client. No Cognito resources are created in this mode. Access tokens must have aud=mcp_url, the required scope, a user sub, and the configured client claim."
  type = object({
    issuer          = string
    client_id       = string
    required_scope  = string
    client_id_claim = optional(string, "client_id")
    access_token_claim = optional(object({
      name  = string
      value = string
    }))
  })
  default = null

  validation {
    condition = var.external_authorization_server == null ? true : (
      can(regex("^https://[^/?#@\\s]+(/[^?#\\s]*)?$", var.external_authorization_server.issuer)) &&
      try(trimspace(var.external_authorization_server.client_id) != "", false) &&
      try(trimspace(var.external_authorization_server.client_id_claim) != "", false) &&
      can(regex("^[\\x21\\x23-\\x5B\\x5D-\\x7E]+$", var.external_authorization_server.required_scope)) &&
      (var.external_authorization_server.access_token_claim == null ? true : (
        try(trimspace(var.external_authorization_server.access_token_claim.name) != "", false) &&
        try(trimspace(var.external_authorization_server.access_token_claim.value) != "", false)
      ))
    )
    error_message = "The external server needs an HTTPS issuer without credentials, query, or fragment, a nonempty client ID and claim name, one valid OAuth scope, and nonempty access-token marker fields when configured."
  }
}

variable "tool_backend_arn" {
  description = "ARN of the Lambda that executes tools. Receives { tool, arguments, identity } where identity is the verified { sub, clientId }."
  type        = string
}

variable "oauth_proxy_endpoints" {
  description = "Optional public HTTPS Cognito or proxy endpoints using the configured Cognito client. Publishes OAuth metadata at the MCP origin with S256 PKCE and code/refresh grants. The endpoints must support those capabilities and be reachable by remote MCP clients. Loopback endpoints are rejected."
  type = object({
    authorization_endpoint = string
    token_endpoint         = string
  })
  default = null

  validation {
    condition = var.oauth_proxy_endpoints == null ? true : (
      var.external_authorization_server == null && alltrue([
        for endpoint in [var.oauth_proxy_endpoints.authorization_endpoint, var.oauth_proxy_endpoints.token_endpoint] :
        can(regex("^https://[a-zA-Z0-9.-]+(:[1-9][0-9]{0,4})?/[^?#@\\s]*$", endpoint)) &&
        !can(regex("(?i)^https://(localhost\\.?|[^/:]+\\.localhost\\.?|127\\.[0-9.]+|0\\.0\\.0\\.0)(:|/)", endpoint)) &&
        try(tonumber(regex(":([0-9]+)/", endpoint)[0]) <= 65535, true)
      ])
    )
    error_message = "oauth_proxy_endpoints requires Cognito mode and non-loopback HTTPS URLs with paths, valid ports, and no credentials, query, or fragment. Use public Cognito endpoints for deployed clients."
  }
}

variable "tools" {
  description = "MCP tools exposed on the endpoint. input_schema is a JSON Schema with type object (use jsonencode). Supports 2020-12 (default), draft-07, and x-mcp-header annotations on primitive properties; all schemas compile at Lambda startup."
  type = list(object({
    name         = string
    description  = string
    input_schema = string
  }))
}

variable "server_name" {
  description = "MCP implementation name returned in result metadata and legacy initialize."
  type        = string
}

variable "server_version" {
  description = "MCP implementation version returned in result metadata and legacy initialize."
  type        = string
  default     = "1.0.0"
}

variable "allowed_origins" {
  description = "Exact canonical HTTP(S) browser origins allowed by Origin validation and CORS. Empty denies supplied Origin headers; native clients may omit Origin. No wildcards, paths, credentials, or default ports."
  type        = set(string)
  default     = []
  nullable    = false

  validation {
    condition = alltrue([for origin in var.allowed_origins :
      can(regex("^https?://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\\[[0-9a-f:]+\\])(:[1-9][0-9]{0,4})?$", origin)) &&
      try(tonumber(regex(":([0-9]+)$", origin)[0]) <= 65535, true) &&
      !(startswith(origin, "https://") && endswith(origin, ":443")) &&
      !(startswith(origin, "http://") && endswith(origin, ":80"))
    ])
    error_message = "allowed_origins must contain exact canonical http:// or https:// origins with an optional port from 1 to 65535. Omit default ports; wildcards, paths, credentials, and opaque origins are not allowed."
  }
}

variable "allow_unbound_access_tokens" {
  description = "Legacy compatibility only. Accept MCP-client access tokens without an aud claim. Default requires tokens bound to mcp_url with OAuth resource indicators."
  type        = bool
  default     = false

  validation {
    condition     = var.external_authorization_server == null || !var.allow_unbound_access_tokens
    error_message = "External authorization servers must issue access tokens bound to mcp_url; legacy unbound-token compatibility is Cognito-only."
  }
}

variable "lambda_memory_mb" {
  type    = number
  default = 256
}

variable "lambda_timeout_s" {
  description = "Integer from 3 to 31. HTTP integration expires one second earlier; tool waiting expires another second earlier, including elapsed request time and cold start."
  type        = number
  default     = 29
  nullable    = false

  validation {
    condition     = var.lambda_timeout_s == floor(var.lambda_timeout_s) && var.lambda_timeout_s >= 3 && var.lambda_timeout_s <= 31
    error_message = "lambda_timeout_s must be an integer from 3 to 31, leaving a valid HTTP API integration (2–30 seconds) and a one-second response margin."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

locals {
  integration_timeout_ms = (var.lambda_timeout_s - 1) * 1000
  tool_timeout_ms        = (var.lambda_timeout_s - 2) * 1000
  cors_methods           = ["GET", "POST", "OPTIONS"]
  # Canonical JSON exposes annotation names without depending on schema layout.
  # The Lambda validates their token syntax, uniqueness, and property paths.
  tool_param_headers = distinct(flatten([for tool in var.tools : [
    for annotation in regexall("\"x-mcp-header\":\"((?:\\\\.|[^\"\\\\])*)\"", jsonencode(jsondecode(tool.input_schema))) :
    "mcp-param-${lower(jsondecode("\"${annotation[0]}\""))}"
    if can(regex("^[!#$%&'*+.^_\\x60|~0-9A-Za-z-]+$", jsondecode("\"${annotation[0]}\"")))
  ]]))
  cors_request_headers   = concat(["authorization", "content-type", "mcp-protocol-version", "accept", "mcp-method", "mcp-name"], local.tool_param_headers)
  cors_expose_headers    = ["WWW-Authenticate"]
  full_scope             = var.external_authorization_server == null ? try(var.cognito_authorization_server.required_scope, null) : var.external_authorization_server.required_scope
  mcp_url                = "https://${aws_cloudfront_distribution.mcp.domain_name}/mcp"
  resource_metadata_url  = "${aws_apigatewayv2_api.mcp.api_endpoint}/.well-known/oauth-protected-resource/mcp"
  authorization_issuer   = var.external_authorization_server == null ? try(var.cognito_authorization_server.issuer, null) : var.external_authorization_server.issuer
  oauth_discovery_issuer = var.oauth_proxy_endpoints == null ? local.authorization_issuer : trimsuffix(local.mcp_url, "/mcp")
  oauth_server_metadata = var.oauth_proxy_endpoints == null ? null : {
    issuer                                = local.oauth_discovery_issuer
    authorization_endpoint                = var.oauth_proxy_endpoints.authorization_endpoint
    token_endpoint                        = var.oauth_proxy_endpoints.token_endpoint
    response_types_supported              = ["code"]
    grant_types_supported                 = ["authorization_code", "refresh_token"]
    token_endpoint_auth_methods_supported = ["none"]
    code_challenge_methods_supported      = ["S256"]
    client_id_metadata_document_supported = false
    scopes_supported                      = ["openid", "email", local.full_scope]
  }
  authorization_mode = var.external_authorization_server == null ? "cognito" : "external"
  mcp_client_id      = var.external_authorization_server == null ? try(var.cognito_authorization_server.client_id, null) : var.external_authorization_server.client_id
  client_id_claim    = var.external_authorization_server == null ? "client_id" : var.external_authorization_server.client_id_claim
  access_token_claim = var.external_authorization_server == null ? {
    name = "token_use", value = "access"
  } : var.external_authorization_server.access_token_claim
  tools_manifest = jsonencode({
    serverName    = var.server_name
    serverVersion = var.server_version
    tools = [for t in var.tools : {
      name        = t.name
      description = t.description
      inputSchema = jsondecode(t.input_schema)
    }]
  })
}
