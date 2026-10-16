# Tool schemas, hand-derived from the verified `proxy` GraphQL operations
# (ticket 10). JSON-Schema per tool, passed as JSON-encoded strings.
#
# `getMyBookedEvents(startTime?: DateTime) → [BookingEvent]`
# `getMyMemberships(all?: Boolean) → [UserMembership]`

locals {
  get_my_booked_events_input = jsonencode({
    type       = "object"
    properties = {
      # GraphQL: DateTime — a SQL date-time or date string; the Lambda's
      # LenientDateTime scalar accepts both. Optional: without it, "now".
      startTime = { type = "string", description = "Optional ISO date or datetime; returns that month's events." }
    }
    required = []
  })

  get_my_booked_events_output = jsonencode({
    type       = "object"
    properties = {
      # Lambda target returns the GraphQL data envelope; the events array is
      # the payload. Fields trimmed to what an assistant answers from.
      events = {
        type        = "array"
        description = "The user's booked events for the requested month (subscriptions, reservations, classes)."
        items = {
          type = "object"
          properties_json = jsonencode({
            id          = { type = "integer", description = "BookingEvent id" }
            name        = { type = "string", description = "Event name" }
            startTime   = { type = "string", description = "Start time" }
            endTime     = { type = "string", description = "End time" }
            type        = { type = "string", description = "Event type (session/reservation/class)" }
            entityType  = { type = "string", description = "Underlying entity type" }
            serviceName = { type = "string", description = "Service name when present" }
            location    = { type = "string", description = "Location name when present" }
            status      = { type = "string", description = "Booking status" }
          })
        }
      }
    }
    required = ["events"]
  })

  get_my_memberships_input = jsonencode({
    type       = "object"
    properties = {
      # GraphQL: Boolean — include memberships without subscription rules.
      all = { type = "boolean", description = "Optional: include all memberships (default: active-only view)." }
    }
    required = []
  })

  get_my_memberships_output = jsonencode({
    type       = "object"
    properties = {
      memberships = {
        type        = "array"
        description = "The user's memberships (active state, counters, validity)."
        items = {
          type = "object"
          properties_json = jsonencode({
            id                   = { type = "integer", description = "UserMembership id" }
            membershipName       = { type = "string", description = "Membership name" }
            membershipType       = { type = "string", description = "membership type (service/access/...)" }
            isActive             = { type = "boolean", description = "Whether the membership is active" }
            startTime            = { type = "string", description = "Validity start" }
            endTime              = { type = "string", description = "Validity end (null = open)" }
            sessionsCounter      = { type = "integer", description = "Remaining sessions" }
            reservationsCounter  = { type = "integer", description = "Remaining reservations" }
            providerName         = { type = "string", description = "Provider offering the membership" }
          })
        }
      }
    }
    required = ["memberships"]
  })

  verified_targets = [
    {
      name             = "get-my-booked-events"
      description      = "The logged-in user's bookings, subscriptions and reservations (GraphQL getMyBookedEvents; per-user scoped by the injected Claims userId)."
      lambda_arn       = var.gateway_lambda_target_arn
      tool_name        = "get_my_booked_events"
      tool_description = "Read the logged-in user's booked events (sessions, reservations, classes) for a month. Per-user: always the caller's own data."
      input_schema     = local.get_my_booked_events_input
      output_schema    = local.get_my_booked_events_output
    },
    {
      name             = "get-my-memberships"
      description      = "The logged-in user's memberships (GraphQL getMyMemberships; per-user scoped by the injected Claims userId)."
      lambda_arn       = var.gateway_lambda_target_arn
      tool_name        = "get_my_memberships"
      tool_description = "Read the logged-in user's memberships: what they hold, active state, remaining sessions/reservations. Per-user: always the caller's own data."
      input_schema     = local.get_my_memberships_input
      output_schema    = local.get_my_memberships_output
    },
  ]
}

module "mcp" {
  source      = "../../modules/mcp-gateway"
  name        = var.name
  region      = var.region
  user_pool_id = var.user_pool_id

  # The existing Apollo graphql.ts Lambda (unchanged target, per ADR-0001).
  gateway_lambda_target_arn = var.gateway_lambda_target_arn

  web_client_callback_url = var.mcp_client_callback_url
  web_client_logout_url   = var.mcp_client_logout_url

  targets = local.verified_targets
}

output "gateway_url" {
  value = module.mcp.gateway_url
}
