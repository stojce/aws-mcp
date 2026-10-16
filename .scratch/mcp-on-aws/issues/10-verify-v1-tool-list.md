# Ticket 10: Verify v1 tool list against the real proxy GraphQL schema

Type: task
Status: resolved

## What to build

The v1 tool list is verified, not assumed: `getMyBookedEvents`, `getCustomerEvents`, and the 1–3 sibling subscription/reservation candidate reads are confirmed to (a) exist on the `proxy` GraphQL surface in the existing mono worktree, and (b) scope per-user data by the caller's Claims (injected identity), never by a client-supplied id. Each verified operation's input/output types are captured so its `toolSchema` can be hand-derived in ticket 13. Any operation that fails the per-user-scoping check is dropped from v1 and the ADR tool table corrected.

**Blocked by:** None (can start immediately).

## Answer

Verified in the mono worktree (`~/Projects/gy/guryou-mono/stage2`, `api/proxy`):

| Candidate | Exists in schema | Caller-scoped? | Verdict |
|---|---|---|---|
| `getMyBookedEvents(startTime?: DateTime) → [BookingEvent]` | yes (`schema.ts:3345`) | yes — `CalendarAPI.getMyBookedEvents` calls `verifyAccessToken()` (no role gate) and queries by token `userId` (`CalendarAPI.ts:775-787`) | **KEEP** |
| `getCustomerEvents(identifier?, startTime?, endTime?, customerId?, isDeal?) → User` | yes (`schema.ts:3343`) | **no** — resolver demands `verifyAccessToken([owner, collaborator, director, manager])` and filters by the *caller's* `providerId` (`CalendarAPI.ts:309-320`); a customer token gets `AuthorizationError` | **DROP** |
| `getMyMemberships(all?: Boolean) → [UserMembership]` | yes (`schema.ts:3465`) | yes — `MembershipsAPI.getMyMemberships` scopes by token `userId` (`MembershipsAPI.ts:116-127`) | **KEEP** |
| `getCustomerBundleItems` | yes | no — admin/owner/manager only (`BundleAPI.ts:125-127`) | DROP (kept out of v1 list; customer twin `getMyBundleItems` exists (`BundleAPI.ts:157-164`) but is **not in the generated schema** so cannot be a Gateway tool as-is) |
| `getMyEntitlementsNow` | **not in schema** (datasource-only; `MembershipsAPI.ts:139`) | — | DROP (no MCP tool can call it via GraphQL surface) |

**Final v1 tool list (decision-complete for ticket 13):**

1. `getMyBookedEvents(startTime: DateTime)` → `[BookingEvent]` — bookings/subscriptions/reservations view for the logged-in user.
2. `getMyMemberships(all: Boolean)` → `[UserMembership]` — the user's active memberships/pay-as-you-go grants.

Two tools: within the "2 to 5" contract; further siblings would add surface without added user value at v1. `getCustomerEvents` stays a candidate for a future provider-side assistant (owner-role audience), out of v1 scope. `sub` carries Cognito identity UUID only — no PII; CloudTrail-safe.

Verification evidence: schema file + resolver/datasource line numbers cited above, checked in the `stage2` worktree at 99a5599ef (2026-10-16).
