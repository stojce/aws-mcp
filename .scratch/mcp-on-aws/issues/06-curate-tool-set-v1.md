# Ticket 06: Grilling curation: which 2 to 5 operations become MCP tools at v1

Type: grilling
Status: resolved
Blocked by: 04

## Question

**User task, not agent:** the user lists the candidate Lambda functions (names + one-line purpose) and the high-value GraphQL operations from their existing stack. Together, pick the 2 to 5 that become MCP tools at v1, judging by (a) agent-callability of the function's I/O shape, (b) real end-user value, (c) how cleanly per-user authorization maps onto each (does the existing function already scope by the caller's identity?). Record the outcome as one table row per chosen tool: name wrangled from the existing Lambda's name, what it does, whether its shape is agent-usable as-is or needs a thin adapter, and whether its authorization is already per-user.

## Answer

<!-- filled on resolution -->
## Answer

Curation settled (round 4 grilling, session 2; all recommended options accepted):

- **First consumer: end-user (customer-facing) assistant.** Tools answer "my ..." questions; per-user claims in `appContext` (userId/userRole/providerId/isAnonymous from `libs/auth-cognito` normalizeClaims) already scope reads correctly.
- **v1 tool family: booking/subscription reads for the logged-in user**, hand-picked from the existing GraphQL surface's **already per-user-scoped** operations. Existing surface = 165 Queries + 244 Mutations across 65 datasources; curation was real (not everything is agent-appropriate).
- **v1 candidate list (from proxy graphql generated schema):**
  - `getMyBookedEvents(startTime)` → typed `[BookingEvent]`
  - `getCustomerEvents(identifier, startTime, endTime, customerId, isDeal)` → `User` (per-user subscription + reservation view from owner's provider)
  - plus 1 to 3 of the closest subscription/reservation read ops from `ReservationsAPI`/`SubscriptionsAPI` datasources, finalized at module-consumption time.
- **Tool schema definition:** each MCP tool's `toolSchema` is **hand-derived from the matching GraphQL operation's input/output types** (Gateway Lambda target signature), so the MCP surface stays stable even as GraphQL evolves behind it.
- Raw existing Lambda list (crons/infra handlers like bookingCron, videoTranscoderListener, sqsMessage): **none used** as tools; they exist as targets in name only in `lambdas.tf`. The real target is the single Apollo `graphql.ts` Lambda, one invocation per MCP tool name.
- All mutations (244) are excluded from v1. Cancellations/changes can graduate to tools later, after reads prove agent-ergonomic.

## Correction (2026-10-16, ticket 10 verification)

`getCustomerEvents` **dropped**: its resolver `verifyAccessToken([owner, collaborator, director, manager])` and scopes by the *caller's* `providerId` (owner-side view of a named customer). A customer token hits `AuthorizationError`; usable only as a provider-side tool later. Final v1 list:

| Tool | Operation | Scoping |
|---|---|---|
| `get_my_booked_events` | `getMyBookedEvents(startTime?: DateTime) → [BookingEvent]` | by token `userId` (`verifyAccessToken()` no role gate) |
| `get_my_memberships` | `getMyMemberships(all?: Boolean) → [UserMembership]` | by token `userId` |
