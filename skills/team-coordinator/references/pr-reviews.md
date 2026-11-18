# PR reviews across harnesses

Area leads own review follow-through under the [operating cycle](operating-cycle.md).
Technical review and human product review are distinct: an adversary PASS does
not supply screenshots, a feature demo or a human decision. Return findings to the
area lead; the chief of staff queues only decisions the human must make.

Use this workflow for PR reviewers and adversaries in Claude Code, Codex, Cursor
or any harness with delegation. The coordinator owns the plan and integration;
independent reviewers and helpers return evidence. Roles are portable
instructions, not fixed model names. Keep the scoring, Jev cross-check, fix
threshold and deferred-finding rules in the coordinator's
[review instructions](../SKILL.md#review-instructions).

## Pin and isolate

1. Read the PR and record its repository, base SHA, head SHA, review scope and
   user authorization. Record checkout, branch, HEAD, dirty state and owner before
   any checkout work. Pin the PR's base branch (the default branch, or the parent
   branch of a stacked PR) and review the PR's net diff with `git diff
   <base>...<head>`. Never review the base's own diff, such as a diff between an
   old head and a merge head. A finding is in scope only when a changed (`+`/`-`)
   line of that net diff causes it; hunk context lines do not count. When the
   base was merged in, read the resolved conflict hunks as context for those
   lines; a resolution that keeps the base's line adds no scope. A regression a
   changed line causes stays in scope even when it surfaces in unchanged code,
   such as a caller broken by a changed return value. A pre-existing defect the PR
   neither touches nor causes is out of scope; suggest an issue instead. Run
   `git log --merges <base>..<head>`: a merge commit that brings in a sibling
   packet's branch the plan does not name as a dependency is a blocking finding,
   fixed by rebuilding the packet from `origin/main`. A PR
   number or worktree name alone does not select its contents.
2. Prefer the already assigned review worktree when its HEAD matches the
   candidate. Preserve unrelated dirty work. Create another worktree only within
   explicit authorization; never repurpose an author's active checkout. A request
   to set up this workflow does not itself request a new worktree or launch a
   review. Write the PR diff to a file (excluding generated snapshots), read it
   in chunks and return a files-reviewed log whose count matches the PR file
   count.
3. Use the harness's delegation tool with worktree isolation for a requested
   separate checkout, and verify the child's actual HEAD: its initial parent
   commit may differ from the PR head. For a helper that needs no separate
   checkout, use the harness's native subagent tool. Do not launch top-level
   threads for delegated reviews.
4. Pin every brief and result to the candidate SHA. After a fix or PR update,
   re-pin the candidate and obtain a fresh independent review of affected
   behavior. Earlier PASS results remain evidence for their original SHA only.

Worked example of the scope rule: a brief asked for a diff between an old head and
a merge head after merging the base in. The adversary failed the PR on a file that
came from another PR and was unchanged by this one; it should have been filed as a
separate issue. Always diff against the pinned base.

## Route the team and consult the advisor

Run a known command directly when the operation is deterministic. Route reviewer,
advisor or helper dispatches against the live executor catalog
(`--available <catalog file>`). For equivalent standalone review dispatches,
pass `--reuse-dir <task-owned dir> --reuse-risk <label>` on the first route and
subsequent re-check. Reuse the label only while role, review scope, risk and
requested executor constraints are equivalent. A material change needs a fresh
route. The reused decision selects an executor; still run a fresh independent
review of affected behavior. The verdict is a recommendation, not permission to
invent an unavailable provider or model. Honor explicit model choices and report
unavailability to the lead under the coordinator's replacement rules. Retain the
routing receipt or bounded unavailability evidence. Do not change thresholds or
substitute a dry run for consultation.

Select a review lead and an independent advisor from live harness capabilities.
The advisor must be a distinct agent with enough capability for the decision; it
may use another harness. A second self-review or Jev's route verdict is not
independent advisor review. A standalone helper has no board writes; when the
work uses the team board, the coordinator records roles, claims, `--review`
tasks, evidence and results.

Consult the advisor at these checkpoints, retaining the question and response:

- Before locking the review/fix plan: supply the pinned diff, acceptance scope,
  planned specialists, checks and material uncertainties.
- After the same failure twice: stop repeating that approach and supply both
  attempts, exact errors, evidence and proposed next options.
- Before the verdict: supply findings and scores, call-site coverage, actual
  check results and skips, deferred issues and remaining acceptance gaps.

An unavailable advisor is a reported missing checkpoint, not an advisor PASS. The
lead resolves it under existing authority or reports the gap. Advisors and Jev give
judgment, never permission or proof. Do not require human approval at each
checkpoint when the work is already authorized.

## Portable helper contracts

These read-only contracts apply to call-site and test-runner helpers, not to
reviewers or adversaries, who fix qualifying findings in assigned files. Give each
helper the absolute checkout path, base and head SHAs, changed symbols or approved
commands, allowed evidence directory and required result format. They must not
edit source, stage, commit, push, update snapshots, install dependencies, change
configuration or dispatch further agents. Enforce read-only tool access where
supported. A shell-capable test helper is constrained by its task rather than made
filesystem-read-only by its role name: tests may write disposable artifacts or
mutate an explicitly assigned test database.

Put this in every helper brief: never read credential files (`.env*`, `.npmrc`,
`.netrc`, private keys, `.pem`), print or inspect environment variables, or run
scripts that dump the environment for diagnosis. Approved tests may consume their
assigned environment internally; that does not authorize exposing its values. If
credentials appear unexpectedly in tool output or logs, stop that diagnostic path
and report the exposure to the coordinator without repeating the values or
attaching the affected output.

### call-sites

Find callers of every supplied changed function or exported contract. Search
direct imports, re-exports, aliases, wrappers, registrations and relevant dynamic
dispatch. Use a code graph or symbol index when available and fresh, then text
search and source inspection; a text hit alone is not a caller. Include tests and
cross-workspace consumers. Return symbol, caller path and line, how it reaches the
symbol, affected behavior and uncovered boundaries. Report an empty caller set
explicitly. Do not claim exhaustiveness when reflection, native bridges or a
missing graph or source prevents it; name the remaining search boundary.

### test-runner

Read the project's command skill and run only the coordinator-approved affected
suites in the pinned checkout with the assigned environment and disposable
resources. The approved set is the whole affected package suite, not only the
changed folders: repo-wide guards such as coverage checks, route inventories and
shared goldens live outside them. Do not start a whole-repo run or a new
CI-policy suite by default. Keep full logs outside tracked source. Report
detailed output only for failures: command, exit code, failing test, error excerpt
and log path. Always include one compact PASS/FAIL/BLOCKED/UNKNOWN summary naming
commands run and skips; no failures must not conceal an unexecuted suite, missing
dependency or database-backed skips. Never fix code or weaken a test to obtain
green. Read the runner's file count as well as its test count, and list failed
tests in each failing file before calling any failure known noise. Changes to
shared test infrastructure (a snapshot registry, a shared seed fixture) require
every suite and guard that uses it before merge.

## Merge gate

Until every lead gate reports, say "do not merge yet" plainly; never call the PR
ready. Before merging, merge the current default branch into the branch locally
and run the affected suites on that result. Immediately before every merge,
re-verify mergeability at the reviewed head: the head SHA has not changed, the PR
is open, not a draft, targets the intended base, and the forge reports it
mergeable. Merge with a match-head-commit guard so a push after review cannot
slip in. Re-run that check when an adversary PASS lands, so a conflicting PR is
updated and re-reviewed before it queues. A project supplies its own merge-check
script and exit-code contract (mergeable / do not merge / tool error /
still-computing); treat a tool error as not a pass.

## Harness adapters and fix ownership

Harness-specific adapters (Claude Code agent definitions in `agents/`) wrap these
shared contracts; other harnesses receive them in delegated briefs. The Claude
adapters use the small-model alias only when the live route and model selection
agree; confirm which model the alias resolves to rather than assuming. A
differently routed helper uses the portable contract with its selected executor.

Invoke the project's `code-review` skill with the PR and high thoroughness; use a
`--fix` argument only if the installed command supports it and fixes were
authorized, otherwise pass those requirements in the task brief. Keep Standards
and Spec reviewers independent, with writable ownership to apply qualifying
findings. Reviewers and adversaries inspect diffs and test source and may add
tests in new files; locked tests change only through a lead-assigned test worker.
Reviewers never execute tests, including on re-checks. Serialize overlapping edits
or assign disjoint files or authorized isolated checkouts with an integration
owner. A separate test worker or CI runs affected checks in parallel when safe, or
after adversaries finish and before merge. The designated fixer resolves test and
CI failures and integration issues; the coordinator ensures checks cover the final
integrated revision and obtains a fresh independent review of affected fixes
before the final verdict. A test run against an earlier revision does not validate
later review fixes. Do not mix review with an unrequested merge, release or
production action.
