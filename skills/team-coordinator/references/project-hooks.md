# Project hooks: examples

Workers do not read this file. A project copies the hooks it uses into its own
protocol or role skills; these are examples of what such hooks look like.

- **Spec preflight.** Test workers write end-to-end specs before the build and
  cannot run them. Before a lane asks for a device or browser slot, a reviewer
  reads the spec next to one with a committed receipt for the same screen and
  confirms each point with `file:line`: a fresh-environment start passes sign-in
  and onboarding the way the reference does; every asserted or tapped element is
  on screen at that moment (tabs and sheets opened first; a reach helper before
  anything below the fold); every label, test ID and string exists in the source
  at the head under test; opt-in flags, env var names and seeded data are in the
  verifier brief or created by the spec or its seed; no stale fixed dates, no
  unverified log reads, no sleeps or raised timeouts. Put the result in a
  "ready for slot" note. A spec fix found here is made by a fresh test worker or
  by the reviewer in place, never by the verifier during the slot.
- **Verifier briefs.** Name the head, the spec file, the opt-in flags and the
  lane's ports. A verifier who hits a setup hurdle recovers inside the brief's
  allowed fixes rather than stopping, never asks the owner, never requests a
  secret, reruns a timeout-type failure once with no timeout bump, runs specs in
  the foreground one at a time, and posts each pass or fail before starting the
  next. Never end the turn while a run is live or still owed. The lane lead
  reads a quiet verifier thread after about 10 quiet minutes and restarts it once
  in the same device slot.
- **Device slots.** Slots go bottom of a stacked branch first; one device per team
  while a proof is live. A unit that already lost one slot to a spec bug gets a
  fix-in-hold slot: (1) the verifier keeps the environment up and posts what the
  screen showed; (2) the lead dispatches one fixer who edits only the spec
  (never product code, never a locked unit test) and commits within 10 minutes;
  (3) the same verifier reruns in the same hold (at most two fix loops and 30
  minutes); (4) on a pass, post the receipt head and release the slot; still
  failing after two loops or 30 minutes, release the slot and post the verdict;
  (5) a product bug found on the way ends the hold at once and goes back through
  tests first; (6) the final spec head still needs its reviewer's delta verdict
  before merge.
- **Merge intersection.** Before any merge, intersect the PR's changed files with
  every queued PR and report any overlap to the lead.
- **Always-run / related-source tests.** Before any merge or device proof, the
  head has run the project's marked always-run tests (tests that must accompany
  related non-test source changes even without an import edge). The project may
  enforce this in pre-push or CI; document the marker and listing command in the
  project's own protocol, not here.
