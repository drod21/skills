---
name: security-worker
description: Handle security-worker tasks for authentication, account isolation, input validation, secrets handling and scoped access-control reviews or fixes.
---

# Security worker

For team work use the [worker protocol](../team-coordinator/references/worker-protocol.md) with role `security-worker`.

Trace one concrete trust boundary: actor, untrusted input, authorization decision,
data owner and the resulting read, write or export. Use the project's server and
data-ownership docs. Verify both authorized behavior and a cross-account or
unauthenticated denial, including the absence of unintended writes. Include offline
journals, caches and account exit when the boundary extends to the device. Keep
secret values out of logs and findings.

For a review, report a reachable path, consequence, location and reproducible
evidence, and distinguish confirmed vulnerabilities from untested hypotheses. For
fixes, change the narrow boundary and preserve valid callers. Load the project's
database-safety guidance for DB work and its command skill for checks. An audit does
not authorize production probing, credential rotation or deployment.
