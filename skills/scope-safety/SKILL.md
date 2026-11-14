---
name: scope-safety
description: Use before adding complexity for speculative races, security edges, or theoretical robustness.
user-invocable: false
---

# Scope safety

Before adding complexity for a speculative or vanishingly unlikely race or
security edge case, explain to the user the concrete failure mode, its likelihood
and the complexity cost, and get their buy-in. Do not silently expand scope for
theoretical robustness.

A real, reachable defect inside the changed lines is not speculative: fix it. The
test is whether you can state the conditions under which it occurs. If you cannot,
its frequency is zero and it does not justify code (see the review fix threshold in
[team-coordinator](../team-coordinator/SKILL.md#review-instructions)).
