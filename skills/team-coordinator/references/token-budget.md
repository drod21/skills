# Token budget

Every model call re-reads the agent's whole context. Most of the cost comes from
two numbers: the starting context each new agent pays (often 50k to 100k tokens
of harness, skill and tool listings), and how long a session keeps running at a
large context. Measured on one owner's machine (owner, 2026-11-27): 65% of input
tokens went to calls made at 200k to 400k context, in sessions that made 1,000 to
3,000 calls each. These rules bring both numbers down.

## One task per agent

- A delegate does one task, returns its result, and stops. Start a new task with
  a fresh agent and a brief, not by continuing a finished agent. The exception is
  a retained author or reviewer finishing its own work (a fix round on its own
  diff), where the context it already has is the point.
- A lead coordinates and does not build. It reads delegate summaries, not file
  dumps, and hands investigation that sweeps many files to a delegate.
- A lead whose context passes about 200k tokens, or that has closed out a plan,
  writes its handoff ([chief of staff](../../chief-of-staff/SKILL.md)) and lets
  compaction or a fresh session take over, instead of carrying the old plan forward.

## Keep context small

- Load only the skills the brief or the task names. A skill that might apply is
  not a reason to load it.
- Write long command output (test runs, builds, logs) to a file and read the
  tail, the failures, or a `grep` of it. Use quiet or dot reporters. Never print
  a whole log into context.
- Read files by the lines you need. Reviewers read the diff, not whole files
  ([PR reviews](pr-reviews.md#review-instructions)).
- Briefs point at files by absolute path; they do not paste file contents.

## Fewer agents per change

- **One review per PR head.** The `adversary` PASS is the PR's review. Do not add
  a second reviewer or a separate review task for the same head unless the lead
  records a risk reason in the brief (auth, security, money, data migration,
  production config). A second opinion from another model family needs the same
  recorded reason.
- **CI runs the suites.** After review, CI runs the tests on the final head.
  Dispatch a test-runner agent only for a suite CI does not cover, and say which
  one in the brief.
- **Test pairs for behavior only.** Docs-only, copy-only and config-only changes
  that alter no behavior build with `--no-test-pair --reason "<kind of change>"`
  instead of a paired test worker ([tests first](tests-first.md)).
- **No helper agents for small diffs.** A reviewer reads call sites itself when
  the diff touches a few functions; a `call-sites` or explore helper is for
  diffs too large for one context.
- Batch Jev questions on one task into one `jev-ask.ts` or `jev-decide.ts` call
  where the options allow it.
