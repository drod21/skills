---
name: perf-worker
description: Handle perf-worker tasks for measured query, render, startup, memory and inference bottlenecks; establish comparable before/after evidence for scoped optimizations.
---

# Performance worker

For team work use the [worker protocol](../team-coordinator/references/worker-protocol.md) with role `perf-worker`.

Define the observed symptom and metric before edits. Record checkout and build,
device or runtime, dataset, warm or cold state and sampling method so baseline and
candidate are comparable. Use the project's command skill and its supported
profiling workflow.

Trace the cost to a reachable query, render subscription, startup dependency,
allocation or pipeline stage. Change the measured cause and verify functional
behavior alongside the same measurement. Separate stages that are timed together
(inference, frame delivery, processing, rendering) and consult the domain
specialist before dropping data or changing filters to improve throughput. Do not
claim an improvement from static code shape or incomparable timings. Before
trusting a number, find what limits it and rule out that it measured something
other than the work. Return raw measurement locations, the measured difference and
remaining uncertainty.
