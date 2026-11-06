variable "name" {
  description = "Deployment short name."
  type        = string
  default     = "mcp-demo"
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "enable_password_auth_for_tests" {
  description = "TEST-ONLY. Lets the smoke test mint tokens with USER_PASSWORD_AUTH. Keep false outside the sandbox."
  type        = bool
  default     = false
}

variable "callback_urls" {
  description = "Pre-registered authorization-code callbacks for hosted MCP clients. Register the exact callback displayed by each client. Local development callbacks require an explicit override."
  type        = list(string)
  default = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://mcptest.io/oauth/callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
  ]
}

variable "oauth_proxy_endpoints" {
  description = "Optional public HTTPS OAuth endpoint overrides. Default null builds both endpoints from the deployed Cognito domain and publishes S256 metadata. No local login server is required."
  type = object({
    authorization_endpoint = string
    token_endpoint         = string
  })
  default = null
}

variable "allowed_origins" {
  description = "Exact browser origins allowed to call MCP. Defaults support mcptest.io. Register OAuth callbacks separately; native clients need no origin entry. Local development origins require an explicit override."
  type        = set(string)
  default     = ["https://mcptest.io"]
}

variable "test_users" {
  description = "Two test users keyed by short name. Passwords are NOT here: set them with scripts/set-test-passwords.sh from env vars so they never enter Terraform state."
  type = map(object({
    email = string
  }))
  default = {
    alice = { email = "alice@example.com" }
    bob   = { email = "bob@example.com" }
  }
}

variable "demo_bookings" {
  description = "Seed bookings. owner_sub_key must match a key in test_users."
  type = list(object({
    id            = string
    owner_sub_key = string
    status        = string
    title         = string
    when          = string
  }))
  default = [
    { id = "b1", owner_sub_key = "alice", status = "confirmed", title = "Yoga class", when = "2026-11-02T18:00:00Z" },
    { id = "b2", owner_sub_key = "alice", status = "past", title = "Dentist", when = "2026-09-10T09:00:00Z" },
    { id = "b3", owner_sub_key = "bob", status = "confirmed", title = "Bike tour", when = "2026-11-05T08:30:00Z" },
  ]
}
