# Completing a task

The detail behind step 6 of the [worker protocol](worker-protocol.md).

`node "$TOOLKIT/scripts/team-tasks.mjs" done <id> --owner
<your-owner-id> [--evidence <item>]` only after the agreed deliverable and its
acceptance checks pass. On a task with pinned `gitProof`, run
`verify-git <id> --by <owner>` before `done`. On a task with `accept`, run `jev-ask.ts
--check-evidence --summary <text> --task <id> --by <your-owner>` as the last
Jev call, then `done`. For mixed Git and Jev tasks or when historical reports
coexist with current proof, add
`--phase "merged acceptance" --current-evidence <retained-path>` (repeat the
flag per receipt, both flags together, exact stored paths from `show <id>`,
not basenames or original temp paths). Phase and summary are declarations, not
proof. A phased check sends only selected receipts within the existing caps.
Use `evidence <id> --supporting <path>` for a receipt or handoff that carries
no acceptance input. Attach new acceptance evidence before checking again.
The board revalidates selected file hashes before completion.
An unreadable, guarded, over-cap or out-of-range
image refuses before any provider call. Each image side must be 280 to 1568
pixels; resize with `sips -Z 1568`.

A later `decide`, answered ask, release or reap invalidates that check, and so
does new acceptance evidence: attach it with `evidence` before the check, not
with `done --evidence` after it. If one of those lands while the check waits on
Jev, the board refuses the check and `jev-ask` exits 1; run it again. The latest
check decides: a rejected or held check after a confirmed one blocks `done`
again. Repeat `--evidence` for more than one path; a comma stays inside the
item. `done` keeps `claimedAt`, `heartbeatAt`, the run link and the owner; on an
already-done task with an owner, `--owner` must match unless `--force`. A gated
done task cannot take new evidence. The CLI refuses a task that is not claimed
or is owned by someone else, and does not check dependencies, so verify they
are complete first. A task with `accept` is refused while `doneBlockers` is not
empty; `--force` does not skip that. No task finishes while its owner thread is
open: ask with `ask-owner <id> <question...> --by <your-name>`, keep working on
what the question does not block, and run `answer-read <id> --by <your-name>`
once you have read the answer (`inbox` lists it). Never answer your own
question; the board refuses it. If the task includes integration, the
coordinator marks it done after integration checks. A review's deliverable
includes committed and pushed fixes for qualifying findings. Unresolved required
implementation or verification must not be marked complete as if fixed.
