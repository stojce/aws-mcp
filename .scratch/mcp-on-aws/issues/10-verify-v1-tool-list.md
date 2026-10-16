# Ticket 10: Verify v1 tool list against the real proxy GraphQL schema

**What to build:** the v1 tool list is verified, not assumed: `getMyBookedEvents`, `getCustomerEvents`, and the 1–3 sibling subscription/reservation candidate reads are confirmed to (a) exist on the `proxy` GraphQL surface in the existing mono worktree, and (b) scope per-user data by the caller's Claims (injected identity), never by a client-supplied id. Each verified operation's input/output types are captured so its `toolSchema` can be hand-derived in ticket 13. Any operation that fails the per-user-scoping check is dropped from v1 and the ADR tool table corrected.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Each candidate read verified against the real schema (exists, typed, caller-scoped) — checked in the mono worktree, not from the names in this repo's tickets.
- [ ] Non-compliant operations dropped; ADR-0001 tool table corrected to the final v1 list.
- [ ] For each surviving operation: input arguments and output shape recorded in this ticket's Answer, ready for `toolSchema` derivation.
- [ ] `sub` carries no PII (CloudTrail logs it); the verification notes confirm this holds for the chosen reads.
