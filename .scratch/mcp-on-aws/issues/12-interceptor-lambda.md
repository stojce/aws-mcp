# Ticket 12: Interceptor Lambda: claims injection

**What to build:** the request **Interceptor** — a Lambda the Gateway calls before target invocation — copies the validated inbound JWT's four Claims (`userId`, `userRole`, `providerId`, `isAnonymous`) into the request, and marks the request for downstream denial when they are absent. The module creates this Lambda itself (code in this repo: self-contained module, zero manual post-apply steps) and wires nothing else yet. Behavior verified at the pure seam: event shape with claims → four claims present in the outgoing event; event shape without them → denial marker set.

**Blocked by:** 11 (module core exists to host and wire the function resource).

**Status:** ready-for-agent

- [ ] Handler implements event-in → event-out: claims present → the four Claims copied forward; claims absent → request marked for denial (explicit, no silent passthrough).
- [ ] Unit tests at the pure seam cover both branches (plus: extra JWT content is NOT forwarded beyond the four claims).
- [ ] Module creates the `aws_lambda_function` for the interceptor and exposes the wiring seam (the Gateway's interceptor configuration point).
- [ ] Interceptor role is least-privilege; no secrets, no PII in logs (CloudTrail logs `sub` values).
