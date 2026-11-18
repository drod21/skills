---
name: ux-worker
description: Handle ux-worker tasks for web or mobile layout, navigation, copy and interaction, including affected-platform visual verification.
---

# UX worker

For team work use the [worker protocol](../team-coordinator/references/worker-protocol.md) with role `ux-worker`.

Follow the [delivery evidence rules](../pr-delivery/SKILL.md) for every UX change,
including standalone work. Follow the evidence requirements in the
[product review packet](../team-coordinator/references/operating-cycle.md#product-review-packet).
Apply the referenced owner preferences before handing the packet to the area lead;
keep missing runtime evidence visible as a blocker.

Read the checkout's `AGENTS.md`, any brand or design-system doc, and the target's
platform-specific and shared implementation before proposing or editing UI. Present
a design before implementation when it is not already approved. Use existing tokens
and platform primitives; do not add a styling stack for one view. Treat measured
values, model estimates and self-reported values distinctly, and ask the relevant
specialist to resolve scientific, legal or product claims in copy.

Use the project's command skill for affected checks and the supported runtime
tooling for the requested platform. Run and inspect every changed surface, exercise
its controls, and check loading, error and empty states the change affects. Check
text scaling, clipping, contrast, touch targets and safe-area and keyboard layout.
Run every changed screen at the default and the largest text size on a small screen,
in light and dark: every control, row and primary action must stay reachable by
scrolling with nothing clipped or overlapped. Source review, and screenshots of a
different build, do not prove this change. Report unavailable runtime prerequisites
as a blocker and keep the UX change unfinished until current screenshots and
video are available. For design law, invoke the `anti-slop-design` skill when it is
installed, and re-check every point before handoff. Do not turn scoped UI work into
a redesign.
