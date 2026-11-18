# Standing leads and one owner queue

This is the team operating contract. The chief of staff owns coordination; area
leads own outcomes; workers own bounded implementation and verification. Jev
remains the judgment advisor under the coordinator's routing and evidence rules.
No role, preference, queue decision or Jev verdict grants tool permission.

## Ownership and continuity

Maintain one named lead per active focus area, using the domains in
[roles.md](roles.md). At cycle start, retain a roster beside the shared board:
area, lead owner/run, objective, allowed scope, task IDs, dependencies, next
action, last activity, wake trigger and blocker. The chief of staff owns this
roster. Use board role `lead` for both chief of staff and area leads, with unique
owner IDs and area tags. These are responsibilities, not new CLI role names or
models. Assign one accountable lead to work crossing domains and consult the other.

Standing means durable responsibility across runs. Use harness-supported wakeups
and resumable handoffs; do not keep an empty model loop polling or claim that a
skill is a daemon. Record the actual scheduler or run and its observed health
before calling an area continuously running; if none exists, record it as
unscheduled. Respect concurrency and spending limits and queue excess work. A
stopped lead needs an explicit recovery handoff under the claim-reassignment rules.

## Each cycle

1. **Reconcile.** The chief of staff checks `inbox`, live runs, board claims,
   pending human decisions and the roster. Leads reconcile their own tasks and
   current checkout and evidence. Read [owner preferences](owner-preferences.md).
   Resume unfinished work before adding more; never reset the shared board.
2. **Prioritize.** The chief of staff orders outcomes by urgency, user impact,
   dependencies and capacity. Each lead accepts a concrete outcome and acceptance
   evidence. Resolve cross-area ownership and file collisions before parallel
   edits. Carry blockers with an owner and a next action.
3. **Execute.** Leads route bounded workers through Jev for code, independent
   tests, reviews and re-checks. Follow the harness's delegation restrictions: a
   child prohibited from spawning returns its proposed dispatch to its parent.
   Leads follow reviews through qualifying fixes and integrated verification.
   Coordinate agents through task handoffs; sending messages to other people
   still requires explicit authorization. After a merge, match CI runs to the
   merge commit SHA and triage failures from the full job log, not its excerpt;
   when the log does not show the failure, read the check-run annotations for file,
   line and message.    Merge in windows: after a merge, hold the next one until the
   default branch's verification run for that commit completes. Before staging a
   release, require one completed green verification run at the frozen head.
   Judge each workflow by its latest completed run; a run cancelled by a newer
   push gives no verdict. In a sharded job, find every shard's result in the full
   log, not the trailing summary. Check the merge commit's runs yourself once
   they finish; do not wait for the owner to notice red.
4. **Prepare.** Leads self-review against applicable preferences and assemble the
   packet below. The chief of staff resolves anything already authorized,
   combines duplicate decisions and sends only genuinely human work to the queue.
5. **Review in batches.** The human answers the prioritized queue. The chief of
   staff records the exact decision and scope, routes it to the responsible lead
   and ensures worker acknowledgment. Independent work continues while waiting.
6. **Learn and resume.** Leads implement corrections, refresh affected evidence
   and return only changed decisions. The chief of staff distills supported
   preferences and measures corrections per change. Keep the next wake trigger in
   the roster.

When a regression reaches the default branch: (1) find the change that caused it
with `git log`; (2) check that change's sibling conversions; (3) use a different
kind of evidence than the gate that leaked (a runtime or device run, not another
diff read); (4) add a test that pins the bug before closing it.

Each lead may propose an evidence-backed idea the owner did not request. Include
the user problem, expected benefit, effort, uncertainty and the cheapest useful
experiment. The chief of staff deduplicates and ranks ideas below blocked delivery
unless impact justifies promotion. Ideas never silently expand authorized scope.

## One prioritized queue

Use the shared board as the single task store, not a second task database.
`scripts/team-tasks.lib.mjs` owns task state and `scripts/team-board-view.mjs`
projects it for a UI. The chief of staff curates one logical human queue across
all areas. Keep agent-only questions out of it. Do not require the human to follow
worker chats.

In a batched packet, list separately each recommendation that adds a release
gate, costs money, or needs the owner's own action or data. A blanket "take all
recommended" does not accept those items; each needs its own answer.

Order: urgent safety, data and release decisions first; blocked authorized
delivery next; ready product reviews next; then proposals. Within a group rank by
impact, deadline, dependencies unblocked, then age, and state the reason. An
agent-resolvable problem belongs with its lead, not at the top of the human queue.

Every item has a stable task reference, area and lead, decision type, priority
reason, age or deadline, a concrete question, a recommended answer, alternatives
and tradeoffs, evidence links and the exact scope awaiting a decision. Keep one
live item per decision; revisions update it and keep history. A stale candidate
must be refreshed before its old approval can apply to changed behavior.

Use `ask-owner`, `answer`, `note`, `lead-reply` and `answer-read` per their
existing semantics. These record conversation, not authenticated human approval.
Attribute a human decision only to an actual human response and record agent
decisions as agents; a chief-of-staff decision never impersonates the owner. An
owner's statement about one item applies to that item only; replace an earlier
standing instruction only after a one-line confirmation. If the viewer cannot
express the packet or ranking, attach a retained packet or index with `evidence`
and reference it in the owner question, as a projection of task IDs; do not invent
board fields or CLI commands.

Target queue interaction: keyboard navigation, open evidence, approve, request
changes, defer and a visible shortcut guide; voice drafts the same structured
actions with a visible transcript and item/scope confirmation before submission.
Batch review preserves a decision per item. Focus in a text field must not trigger
action shortcuts. Ambiguous speech stays a draft. Approving a product review does
not authorize deployment or a production release.

## Product review packet

Apply the [delivery evidence rules](../../pr-delivery/SKILL.md) to every
UX change, including standalone work and changes without a human product review.

For every product review, attach:

- User problem, intended outcome, concise before/after behavior, recommendation
  and the exact decision requested.
- Candidate SHA and any uncommitted patch identity, build and platform,
  reproduction steps and acceptance results with links to actual check output.
- Screenshots of the affected surfaces and any required flow video, captured
  from that candidate through authorized browser or device tools. Include
  relevant failure and empty states.
- Independent review results, deferred findings with their scores and reasons,
  known limitations and any missing evidence with its owner.
- Applicable preference references and how the proposal incorporates them.

QA verifies the artifacts match the candidate and demonstrate the claim; the area
lead checks completeness before chief-of-staff triage. Missing required captures
leave a product review unready. Keep working on obtainable evidence;
escalate an inaccessible runtime as a blocker rather than presenting old or
synthetic captures as proof. Documentation-only and internal changes with no UX
effect can record why product review is not applicable; never manufacture a demo for them. Retain
artifacts at durable task-owned paths. A code or evidence change requires fresh
affected verification, and the existing gate rules still apply.

## Learn the owner's judgment

[owner-preferences.md](owner-preferences.md) is the compact, versioned entry point
for the owner's judgment. The chief of staff maintains it; leads cite it in briefs
and self-review before handoff. Keep raw task decisions and evidence with their
task; put only reusable lessons in the preferences file. Per reviewed change,
retain correction rounds (a returned packet requiring change), reason categories,
first-pass acceptance and owner review time when measured. Compare like work over
successive batches with counts and denominators; unknown measurements stay
unknown. Optimize for fewer repeated corrections and better first drafts, not
fewer reported findings or skipped human decisions.

## Runtime implementation boundary

The [review queue](review-queue.md) describes the packet and revision commands the
board implements. A scheduler, an always-on lead and automatic preference
extraction are separate runtime work this guidance does not provide. Before
reporting the target system operational, verify durable lead restart,
deduplicated cross-area queue ordering, per-item decisions and acknowledgment,
stale-candidate handling, playable screenshot and video evidence, keyboard focus
behavior, voice transcript confirmation and sourced preference updates end to
end. Use [verify-team-board](../../verify-team-board/SKILL.md) when changing the
board's gate, journal or review contracts; the one-task formal checks do not
prove this multi-lead cycle.
