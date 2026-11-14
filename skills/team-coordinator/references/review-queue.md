# Owner review queue

The board stores owner questions; a viewer renders them. Only open owner
questions enter the queue. Jev holds stay with leads on the board. Queue order is
urgent, blocked, review, idea; ties use number of open dependents, question age,
then task ID. A question without a packet counts as blocked. A viewer must not
truncate queue items.

The toolkit ships the packet command and the revision binding
(`scripts/review-queue.mjs`, `--expected`). The viewer itself is project-supplied:
a project that wants keyboard and voice review builds it on `team-board-view.mjs`.
Do not claim the keyboard, voice or media behavior below exists until the project's
viewer implements and verifies it.

## Submit a packet

Attach evidence first with the `evidence` command. Media must sit in
`tasks.json.artifacts/<task-id>/` beside the shared board to be served; the board
copies files from temporary directories up to 25 MiB, so use short videos and the
retained paths from `show`, not the originals. Accepted media: PNG, JPEG, WebP,
MP4, WebM. Arbitrary paths, outside symlinks and stale revision URLs are not
served. Never put sensitive content in a packet.

Write a JSON packet:

```json
{
  "kind": "product",
  "area": "Checkout",
  "lead": "lead-checkout",
  "priority": "review",
  "priorityReason": "Verified feature ready for product review",
  "recommendation": "Accept the compact summary",
  "scope": "Order summary layout only",
  "alternatives": ["Keep the previous layout"],
  "checks": ["Link actual check results, limitations and deferred findings here"],
  "candidate": "Exact SHA plus patch identity and build/platform",
  "screenshots": ["absolute retained screenshot path"],
  "video": "absolute retained video path"
}
```

`kind` is `product`, `decision` or `idea`; only product packets require candidate,
screenshots and video. `priority` is `urgent`, `blocked`, `review` or `idea`. The
packet is bounded by the board's text and privacy guard. Submit on the claimed
task:

```sh
node "$TOOLKIT/scripts/team-tasks.mjs" ask-owner <id> 'Accept this scoped change?' \
  --by <lead-owner> --packet <packet.json>
```

One question stays open at a time. Update substantive evidence before asking; if
a queued candidate changes, send it through the note, `lead-reply` and
`answer-read` lifecycle and ask again with the refreshed packet. Never edit board
JSON to replace a pending question.

## Review a batch

Target viewer behavior: J/K navigate, A drafts approval, R drafts a change
request, D drafts deferral to the lead, V starts browser dictation; typing in a
field never activates those shortcuts; Ctrl/Command+Enter submits the visible
draft; every action has a button; each item is submitted separately with no
approve-all shortcut. Deferral is a durable note for the lead to reprioritize, not
a timed snooze. Dictation leaves an editable transcript and never submits by
itself. Drafts survive polling and in-page item navigation, but are not persisted
across full page reloads.

Answers use `answer`; changes and deferrals use `note`. The viewer sends
`--expected` to the locked board writer, which compares the displayed revision
with current task ownership, status, title, journal and evidence. Heartbeats do
not invalidate it. A conflict keeps the draft and asks for a refresh. Missing
media blocks answering in the viewer; notes stay available to request repair. A
recorded decision is not a release command or an evidence-gate override.

## Checks

Browser verification of a project viewer must cover real playback, focus, drafts,
responsive layout and explicit transcript submission. Test queue ordering, packet
requirements, revision conflicts and retained media boundaries against the real
board functions, not copies of their rules.
