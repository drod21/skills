---
name: specialist-worker
description: Handle specialist-worker tasks in a domain the project defines, such as signal processing, ML evaluation or billing rules. Template for a project's own specialist role skills.
disable-model-invocation: true
---

# Specialist worker

For team work use the [worker protocol](../team-coordinator/references/worker-protocol.md) with role `specialist-worker`, or the project's own role name added through
`team-roles.json` (see [roles](../team-coordinator/references/roles.md)).

This skill is a template. A project that has real specialist domains writes one
role skill per domain, names it in the role table, and keeps the domain rules there,
not in the toolkit. Each such skill answers the same questions:

1. **Ownership.** Which decisions only this specialist makes, and which it hands to
   backend, UX, security, perf or QA.
2. **Evidence.** What counts as proof in this domain (a measurement on recorded
   data, a held-out evaluation, a regulatory source), and what does not.
3. **Hand-offs.** Which claims in other workers' output the specialist must
   approve before they ship (user-facing copy, thresholds, data admission).
4. **Boundaries.** What the specialist never does without the owner: change a
   threshold that is already shipped, admit new data, make a user-facing claim
   about outside facts without checking the source's current terms.

Until a domain skill exists, a specialist-worker states the domain assumptions it
relied on, cites the source for each, separates measured from inferred results, and
returns anything outside its stated evidence to the lead as an open decision.
