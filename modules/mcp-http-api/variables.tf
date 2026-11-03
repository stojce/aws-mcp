variable "name" {
  description = "Short name used in every resource name."
  type        = string
}

variable "user_pool_id" {
  description = "Existing Cognito User Pool id. The module adds a resource server and an MCP app client to it; it never creates the pool."
  type        = string
}

variable "tool_backend_arn" {
  description = "ARN of the Lambda that executes tools. Receives { tool, arguments, identity } where identity is the verified { sub, clientId }."
  type        = string
}

variable "tools" {
  description = "MCP tools exposed on the endpoint. input_schema is a JSON Schema with type object (use jsonencode). Supports 2020-12 (default) and draft-07; all schemas compile at Lambda startup."
  type = list(object({
    name         = string
    description  = string
    input_schema = string
  }))
}

variable "server_name" {
  description = "MCP serverInfo.name returned on initialize."
  type        = string
}

variable "server_version" {
  description = "MCP serverInfo.version returned on initialize."
  type        = string
  default     = "1.0.0"
}

variable "callback_urls" {
  description = "Authorization-code callback URLs for the MCP app client."
  type        = list(string)
}

variable "logout_urls" {
  description = "Logout URLs for the MCP app client."
  type        = list(string)
  default     = []
}

variable "enable_password_auth_for_tests" {
  description = "TEST-ONLY. Adds ALLOW_USER_PASSWORD_AUTH to the MCP client so smoke tests can mint tokens without a browser. Keep false in any real deployment."
  type        = bool
  default     = false
}

variable "resource_server_identifier" {
  description = "Cognito resource-server identifier, unique within user_pool_id. Each module instance owns its resource server; choose a distinct identifier when sharing a pool."
  type        = string
  default     = "mcp"
  nullable    = false

  validation {
    condition     = can(regex("^[\\x21\\x23-\\x5B\\x5D-\\x7E]{1,256}$", var.resource_server_identifier))
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
}

variable "lambda_memory_mb" {
  type    = number
  default = 256
}

variable "lambda_timeout_s" {
  description = "Must exceed the tool backend's worst-case duration plus cold start."
  type        = number
  default     = 29
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
  full_scope            = "${var.resource_server_identifier}/${var.scope_name}"
  mcp_url               = "https://${aws_cloudfront_distribution.mcp.domain_name}/mcp"
  resource_metadata_url = "${aws_apigatewayv2_api.mcp.api_endpoint}/.well-known/oauth-protected-resource/mcp"
  cognito_issuer        = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${var.user_pool_id}"
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
