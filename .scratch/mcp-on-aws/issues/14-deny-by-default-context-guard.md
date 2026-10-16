# Ticket 14: Deny-by-default context guard in the existing app Lambda

**What to build:** the target Lambda's identity path is fail-closed for the MCP ingress: when the Gateway-invoked request lacks the injected Claims, the context builder rejects it with an explicit error instead of falling back to legacy token resolution — a misconfigured Gateway degrades to an error, never to wrongly-scoped data. The existing HTTP-API bearer-token path behaves exactly as before; this is the context-guard only, not a business-logic change (per ticket 09's ADR re-scoping). Verified in the mono's claim-normalization test style.

**Blocked by:** 12 (the injecting Interceptor must exist and be tested first — the guard's "approved shape" is defined by it).

**Status:** ready-for-agent

- [ ] Context builder on the Gateway-ingress route rejectsrequests lacking the injected Claims with an explicit error (deny-by-default); no silent header-bearer fallback on that route.
- [ ] Existing HTTP-API auth path unchanged: bearer token resolution continues to work (regression-checked, not re-pinned incidental behavior).
- [ ] Unit tests in the mono's `libs/auth-cognito` style: with-claims → context built; without-claims → rejected; legacy HTTP path unaffected.
- [ ] Reads ADR-0001 consistently: guard documented as identity plumbing, business logic untouched.
