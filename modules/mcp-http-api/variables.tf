variable "name" {
  description = "Short name used in every resource name."
  type        = string
}

variable "user_pool_id" {
  description = "Existing Cognito User Pool id. Required for Cognito mode; omit when external_authorization_server is configured."
  type        = string
  default     = null

  validation {
    condition = var.external_authorization_server != null ? var.user_pool_id == null : (
      var.user_pool_id == null ? false : trimspace(var.user_pool_id) != ""
    )
    error_message = "Provide user_pool_id for Cognito, or configure external_authorization_server and omit user_pool_id."
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

variable "callback_urls" {
  description = "Authorization-code callback URLs for the Cognito MCP app client. External clients are registered with their authorization server separately."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition     = var.external_authorization_server != null || length(var.callback_urls) > 0
    error_message = "Cognito mode requires at least one registered callback URL."
  }
}

variable "logout_urls" {
  description = "Logout URLs for the MCP app client."
  type        = list(string)
  default     = []
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

variable "enable_password_auth_for_tests" {
  description = "TEST-ONLY. Adds ALLOW_USER_PASSWORD_AUTH to the MCP client so smoke tests can mint tokens without a browser. Keep false in any real deployment."
  type        = bool
  default     = false
}

variable "resource_server_identifier" {
  description = "Cognito resource-server identifier, unique within user_pool_id. Defaults to mcp_url so resource-bound custom scopes can be issued. A different identifier requires allow_unbound_access_tokens for legacy compatibility."
  type        = string
  default     = null

  validation {
    condition     = var.resource_server_identifier == null ? true : can(regex("^[\\x21\\x23-\\x5B\\x5D-\\x7E]{1,256}$", var.resource_server_identifier))
    error_message = "resource_server_identifier must contain 1–256 printable ASCII characters, excluding spaces, double quotes, and backslashes."
  }
}

variable "scope_name" {
  description = "Scope name under the resource server. Tokens carry it as <resource_server_identifier>/<scope_name>."
  type        = string
  default     = "read"
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

variable "tags" {
  type    = map(string)
  default = {}
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
  cors_request_headers       = concat(["authorization", "content-type", "mcp-protocol-version", "accept", "mcp-method", "mcp-name"], local.tool_param_headers)
  cors_expose_headers        = ["WWW-Authenticate"]
  resource_server_identifier = var.resource_server_identifier == null ? local.mcp_url : var.resource_server_identifier
  full_scope                 = var.external_authorization_server == null ? "${local.resource_server_identifier}/${var.scope_name}" : var.external_authorization_server.required_scope
  mcp_url                    = "https://${aws_cloudfront_distribution.mcp.domain_name}/mcp"
  resource_metadata_url      = "${aws_apigatewayv2_api.mcp.api_endpoint}/.well-known/oauth-protected-resource/mcp"
  cognito_issuer             = var.user_pool_id == null ? null : "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${var.user_pool_id}"
  authorization_issuer       = var.external_authorization_server == null ? local.cognito_issuer : var.external_authorization_server.issuer
  authorization_mode         = var.external_authorization_server == null ? "cognito" : "external"
  mcp_client_id              = var.external_authorization_server == null ? aws_cognito_user_pool_client.mcp[0].id : var.external_authorization_server.client_id
  client_id_claim            = var.external_authorization_server == null ? "client_id" : var.external_authorization_server.client_id_claim
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
