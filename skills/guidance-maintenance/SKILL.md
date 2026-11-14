---
name: guidance-maintenance
description: Use during authorized implementation, planning, or audit when repository guidance (AGENTS.md, setup docs, agent references) may change or drift.
user-invocable: false
---

# Maintaining guidance

During authorized implementation you may, and must, update `AGENTS.md`, setup
docs and affected agent-maintained references for factual accuracy, valid routing
and concision, without separate approval for each documentation edit. Use verified
code, configuration, approved decisions and actual check results. Preserve
substantive rules, scope, history, unrelated edits and managed ownership.

Changes to goals, architecture decisions, source authority, security, permissions
or approval requirements need explicit approval. Documentation maintenance cannot
authorize itself to expand task scope. Planning and audit-only work stay read-only.
Report documentation changes and unresolved drift; self-updating happens during
authorized work, not as an unattended background process.

When you catch yourself writing the same instruction a second time, encode it in
structure instead (a lint, a script, a flag, a runtime check) and link to it.
