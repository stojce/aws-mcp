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
  default     = true
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
