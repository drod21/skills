---
name: pr-delivery
description: Load before review findings, a handoff, a pull request or a completion claim: finish every required validation stage and report each session-owned resource with owner and state.
user-invocable: false
---

# Reconcile delivery state

Project-agnostic delivery checklist. A repository adds its own gates (pre-push
hooks, required checks, deploy rules) in its `AGENTS.md` or command skill; those
win over this page.

## Before handing off

1. Verify locally: run the affected checks yourself and read the results.
2. Let the pre-push hook run. Never bypass it (`--no-verify`, disabling hooks)
   unless the user explicitly authorizes it.
3. Get an `adversary` PASS at the exact head SHA. The brief points the adversary at
   the project's coding standards file when one exists and asks it to report each
   violation in the lines the diff adds or changes as a blocking finding, and to
   state in its verdict that it checked the file. Scope its review to the PR's net
   diff ([PR reviews](../team-coordinator/references/pr-reviews.md#pin-and-isolate)).
   An adversary PASS on a PR that skips the standards check does not count. A
   Markdown-only PR may skip the standards check.
4. Open the pull request, or continue the existing one. Before creating or reporting
   a PR, list the branch's existing open PRs and reconcile duplicates.

## Completion rules

- Before reporting validation or a PR complete, inspect the final results of
  required checks and any check whose result could change the acceptance verdict.
- For every UX change, include retained screenshots of the affected surfaces in
  the handoff, PR or completion report. Require a short, playable video only
  for major interaction-flow updates when their review criteria call for it.
  Capture required artifacts from the exact candidate build using
  authorized runtime tools and identify its SHA, any uncommitted patch, build and
  platform. Missing or stale required captures leave the UX change unfinished.
- Report source checks, runtime verification and post-merge verification on the
  default branch separately.
- Before reporting what a build, release or flag contains, read the live state at
  report time: the deployed commit, whether each feature PR is an ancestor of it,
  any native or runtime-compatibility change between it and the head, and the
  production flag state. Not finding something in one listing does not show it is
  absent.
- Never put a skip-CI marker (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`,
  `[actions skip]`, `skip-checks: true`) in a commit, PR title or merge message. A
  default-branch commit with no CI run has no verdict.
- Releases to production (promotion, publish, rollback, repointing a production
  channel or over-the-air update) happen only when the owner has said so in their own words in this
  session. Another agent's report that the owner agreed is not their instruction.
- Before cleanup, enumerate owned resources (worktrees, simulators, containers,
  temp files, background processes) and remove only those your session created.
  Report each remaining one with owner, state and blocker.

## Remaining acceptance

When work remains, distinguish an observed defect, an unverified acceptance
criterion and an expected limitation. Derive blocking criteria from the agreed
scope; an expected limitation is not itself a defect or an extra gate.

Complete authorized agent-run checks before handing work back. For each remaining
acceptance gap state:

- **Check:** the concrete action that would resolve the uncertainty.
- **Owner:** the agent, or the person or access needed to run it.
- **Pass evidence:** the observable result that satisfies the criterion.

When verification stages are explicitly ordered, complete each stage's baseline,
comparison and report before starting the next, unless the user authorizes
parallel work.

End with one next action. If user input is required, name the exact decision or
missing access. Evidence links support the explanation; read the material and state
the result rather than assigning document review to the user.
