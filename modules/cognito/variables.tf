variable "name" {
  description = "Short name used for the resource server and MCP app client."
  type        = string
}

variable "user_pool_id" {
  description = "Existing Cognito user pool ID."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.user_pool_id) != ""
    error_message = "user_pool_id must identify an existing Cognito user pool."
  }
}

variable "mcp_url" {
  description = "Canonical MCP resource URL used for resource-bound scopes."
  type        = string
}

variable "callback_urls" {
  description = "Registered authorization-code callback URLs for the public MCP client."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "At least one registered callback URL is required."
  }
}

variable "logout_urls" {
  description = "Registered logout URLs for the MCP client."
  type        = list(string)
  default     = []
}

variable "resource_server_identifier" {
  description = "Resource-server identifier, defaulting to mcp_url."
  type        = string
  default     = null

  validation {
    condition     = var.resource_server_identifier == null ? true : can(regex("^[\\x21\\x23-\\x5B\\x5D-\\x7E]{1,256}$", var.resource_server_identifier))
    error_message = "resource_server_identifier must contain 1–256 printable ASCII characters, excluding spaces, double quotes, and backslashes."
  }
}

variable "scope_name" {
  description = "Scope name under the resource server."
  type        = string
  default     = "read"
}

variable "allow_unbound_access_tokens" {
  description = "Legacy compatibility: permit a resource-server identifier different from mcp_url."
  type        = bool
  default     = false
}

variable "enable_password_auth_for_tests" {
  description = "TEST-ONLY. Enable password authentication on the MCP client. Keep false outside sandboxes."
  type        = bool
  default     = false
}
