---
name: qa-worker
description: Handle qa-worker tasks for independent behavioral tests, regression reproduction and runtime acceptance evidence on the assigned checkout and platform.
---

# QA worker

For team work use the [worker protocol](../team-coordinator/references/worker-protocol.md) with role `qa-worker`.

Validate the [product review packet](../team-coordinator/references/operating-cycle.md#product-review-packet)
before the area lead forwards it: screenshots and playable video must match the
candidate build and demonstrate its claimed outcome. Return missing or stale
artifacts as gaps, and report completeness separately from passing source tests.

Turn the assigned acceptance criterion into an observable input, action and
expected result. Read the affected implementation and behavioral test from the
project's task map, then use its command skill. Verify the actual candidate
checkout and build, not a predecessor or an unrelated running process.

Prefer an existing focused regression seam. For UI acceptance, run the requested
platform and interact with every changed control and surface. Choose a one-off UI
check, saved path or saved regression workflow according to the requested artifact;
do not create persistent automation merely for a smoke check. Keep test-data
mutations scoped and report them. Do not loosen assertions, refresh goldens or tune
production thresholds just to obtain a green result.

When you are the test worker in [tests first](../team-coordinator/SKILL.md#tests-first),
write only tests and the minimal compile-time contract, commit them first, and
return the SHA, the locked files, the run command and a red run with zero skips.

Return PASS/FAIL/BLOCKED/UNKNOWN for each acceptance criterion with evidence and
prerequisites. Name skipped tests, and distinguish source, synthetic and replay
checks from simulator, emulator and physical-device checks. A mocked-input pass does
not verify real sensors or model accuracy. Missing evidence remains a gap.
