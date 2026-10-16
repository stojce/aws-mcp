# Ticket 09: Close the wayfinder map; scope the ADR's "no code changes" line

**What to build:** the planning archive stops lying to future sessions: the wayfinder map for this effort reads as closed (Status updated from `open`, "Not yet specified" cleared, Decisions-so-far complete), and ADR-0001's "no code changes to `graphql.ts`" is re-scoped to *business logic* — with deny-by-default claims checking named as an accepted consequence, so a future implementer doesn't mistake the context-guard (ticket 14) for an ADR violation.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Map `Status:` line reflects closed/complete; "Not yet specified" section carries no stale fog (may be removed entirely).
- [ ] ADR-0001 states the scope of "no code changes to `graphql.ts`" (business logic unchanged; identity/context plumbing may add the deny-by-default guard), with the reason.
- [ ] No ticket in `issues/` is left un-resolved or unclaimed.
