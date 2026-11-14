# Role selection

For standing area ownership, use the [operating cycle](operating-cycle.md). The
chief of staff and each area lead use board role `lead`, distinguished by unique
owners and area tags. Area leads load the relevant specialist skill and manage
bounded workers; the chief of staff owns cross-area priorities and the single
human queue. Keep one lead per active area, not one agent per skill.

Choose the role by the decision that needs expertise, not by file suffix. The
live role catalog is `scripts/team-catalog.mjs` (`ROLES`). Load only the selected
skill; attach a second specialist to a separate bounded review when a task
crosses domains.

| Board role        | Skill                                           | Primary ownership                                                    |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| lead              | [team-coordinator](../SKILL.md)                 | Decomposition, decisions, holds, integration                         |
| backend-worker    | [backend-worker](../../backend-worker/SKILL.md) | API, persistence, shared non-specialist contracts                    |
| ux-worker         | [ux-worker](../../ux-worker/SKILL.md)           | Web and mobile presentation, navigation, interaction                 |
| security-worker   | [security-worker](../../security-worker/SKILL.md) | Authentication, authorization, validation, secrets                 |
| perf-worker       | [perf-worker](../../perf-worker/SKILL.md)       | Measured query, render, startup and resource bottlenecks             |
| qa-worker         | [qa-worker](../../qa-worker/SKILL.md)           | Independent behavior checks and runtime evidence                     |
| specialist-worker | [specialist-worker](../../specialist-worker/SKILL.md) | A domain the project defines (ML, signal processing, billing...) |

## Adding project roles

A project with several domains does not fork the catalog. Put extra roles in a
JSON file next to the board (`team-roles.json`) or point `TEAM_ROLES_FILE` at one:

```json
{
  "billing-worker": "Pricing rules, invoicing and payment-provider integration",
  "ml-worker": "Dataset admission, learned estimators and evaluation"
}
```

Names are lowercase with hyphens. The board merges them into `ROLES`, so `add`
accepts them and `jev-route` can suggest them. Each extra role should name the
project skill its workers load, in the project's own role table.

## Boundary examples

Resolve ownership by the decision, then name a supporting role for the rest:

- A schema or response change: backend-worker owns the contract; ux-worker checks
  the actual consumers; qa-worker verifies the integrated behavior.
- A measured slowdown: perf-worker owns the measurement and the narrow fix; the
  domain specialist approves any change to behavior the optimization touches.
- A cross-account data path: security-worker owns the access boundary;
  backend-worker owns an agreed patch.
- A scientific, legal or product claim in user-facing copy: the specialist
  resolves the claim; ux-worker owns the wording and layout.

Executor choices stay in the route policy; new domains need no new route names or
fixed model assignments.
