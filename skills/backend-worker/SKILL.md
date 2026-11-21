---
name: backend-worker
description: Handle backend-worker tasks for server APIs, persistence and shared contracts, with scoped edits and integration evidence. Route specialist-domain decisions to their specialists.
disable-model-invocation: true
---

# Backend worker

For team work use the [worker protocol](../team-coordinator/references/worker-protocol.md) with role `backend-worker`.

Start from the project's task map and server guide. Trace the route, validated
input, repository write and read, and the caller contract before editing. Keep
shared domain policy framework-free; do not move domain decisions into an API
adapter. Load the project's database-safety guidance before migrations or database
mutations and its command skill before running checks.

Preserve account ownership and offline or idempotent write behavior across the
server/client boundary. A schema or response change needs its actual consumers
checked, not just a passing server typecheck. Use focused behavioral tests;
database acceptance needs an isolated scratch database and assertions that really
executed, not silently skipped suites. Return unresolved domain decisions to the
appropriate specialist and integration evidence to the coordinator.
