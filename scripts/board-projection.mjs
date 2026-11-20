// The team board, reduced for a person: which tasks need the owner, which have a live
// worker, which claims have gone silent, what is waiting and what finished lately. The
// board is the owner's tasks.json (scripts/team-tasks.mjs) in the repository root; the
// dashboard polls GET /api/board for this view.
//
// Standalone on purpose: a dashboard may serve this file without the rest of scripts/,
// so team-tasks.lib.mjs is not there at run time. The rules copied from
// it: a claim's last signal is heartbeatAt, else claimedAt; a run belongs to the claim only
// when run.at equals claimedAt; an ask or decide hold is open until a later lead choice;
// a dependency blocks until its task is done, and a cancelled one blocks for good; the
// gate rules isInvalidator, hasFreshConfirmation and acceptEvidence's latest held check; and
// ownerThread, the owner's question and note to the lead. scripts/team-board-gate.test.ts
// (verify-team-board) holds this copy to the library.
import { readFileSync, statSync } from 'node:fs'
import { reviewQueue } from './review-queue.mjs'

export const BOARD_FILE = 'tasks.json'
// A claim with no heartbeat for this long is "silent": the board has no clock, so this is a
// display threshold (the same 24 h scripts/team-tasks.mjs stale uses), not a board rule.
export const LIVE_SIGNAL_MS = 24 * 3_600_000
export const DONE_WINDOW_MS = 24 * 3_600_000
export const LIST_CAP = 60

const iso = (ms) => new Date(ms).toISOString()
const parseAt = (value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN)
const text = (value) => (typeof value === 'string' ? value : null)
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const entries = (list) => (Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [])

const lastSignal = (task) => text(task.heartbeatAt) ?? text(task.claimedAt) ?? null

function currentRun(task) {
  const run = task.run
  if (task.status !== 'claimed' || !run || typeof run !== 'object' || Array.isArray(run)) return null
  if (run.at !== task.claimedAt) return null
  return { kind: text(run.kind), ref: text(run.ref) }
}

const isJudgment = (e) => e.kind === 'judgment'
const isCheck = (e) => isJudgment(e) && e.tool === 'check'
const isHold = (e) => isJudgment(e) && e.outcome === 'hold' && (e.tool === 'ask' || e.tool === 'decide')

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [])

// A check judged one evidence set; it speaks for the task only while that set is unchanged
// (the board's sameEvidence). More evidence since means the worker is back at it.
function sameEvidence(check, evidence) {
  const a = new Set(strings(check.evidence))
  const b = new Set(strings(evidence))
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

// The board's isInvalidator: a lead choice, a release, a note that reopens finished work, or an
// answered ask or decide voids every judgment before it.
const isInvalidator = (e) =>
  e.kind === 'choice' ||
  e.kind === 'release' ||
  (e.kind === 'note' && Boolean(e.reopened)) ||
  (isJudgment(e) && e.outcome === 'answered' && (e.tool === 'ask' || e.tool === 'decide'))
const isVerdict = (e, evidence) => (isCheck(e) || e.kind === 'accept') && sameEvidence(e, evidence)

// The board's hasFreshConfirmation: the latest check or accept of the current evidence confirms
// it, and nothing voided it since.
function freshlyConfirmed(decisions, evidence) {
  const at = decisions.findLastIndex((e) => isVerdict(e, evidence))
  if (at < 0) return false
  const e = decisions[at]
  if (e.kind !== 'accept' && e.outcome !== 'confirmed') return false
  return !decisions.slice(at + 1).some(isInvalidator)
}

// What a person has to act on. These are the board's own rules, read over the whole journal:
// - an ask or decide hold with no later lead choice, whatever came after it (hasOpenHold:
//   `done` stays refused, a release does not clear it);
// - otherwise, unless a fresh confirmation covers the current evidence, the latest check
//   (checkGate).
function ownerGate(decisions, evidence) {
  const held = decisions.findLastIndex((e, i) => isHold(e) && !decisions.slice(i + 1).some((l) => l.kind === 'choice'))
  if (held >= 0) return { why: 'hold', entry: decisions[held] }
  if (freshlyConfirmed(decisions, evidence)) return null
  const at = decisions.findLastIndex(isCheck)
  return at < 0 ? null : checkGate(decisions[at], decisions.slice(at + 1), evidence)
}

// The latest check stands only for the evidence it judged. A held check waits on the lead's
// accept (acceptEvidence takes it even after a release or a voided accept) until any other
// invalidator changes what it judged. A rejection waits on new evidence or the lead, until a
// release hands the task back to the pool.
function checkGate(check, later, evidence) {
  if (!sameEvidence(check, evidence)) return null
  if (check.outcome === 'hold' && !later.some((l) => l.kind !== 'release' && isInvalidator(l)))
    return { why: 'hold', entry: check }
  if (check.outcome === 'rejected' && !later.some((l) => l.kind === 'release')) return { why: 'rejected', entry: check }
  return null
}

// The board's ownerThread: a question to the owner and a note the owner queued to the lead
// (skills/verify-team-board/SKILL.md).
const THREAD_STEPS = {
  'owner-ask': (s) => ({ ...s, question: 'Asked' }),
  'owner-answer': (s) => ({ ...s, question: 'Answered' }),
  note: (s) => ({ question: s.question === 'Asked' ? 'HandedToLead' : s.question, note: 'NoteQueued' }),
  'note-read': (s) => ({ ...s, note: 'NoteRead' }),
  'lead-reply': (s) => ({ question: s.question === 'HandedToLead' ? 'Answered' : s.question, note: 'NoNote' }),
  'answer-read': (s) => ({ ...s, question: 'NoAsk' }),
  cancel: (s) => ({ ...s, question: 'NoAsk' }),
}

const said = (e) => (e ? { by: text(e.by), at: when(e.at), text: text(e.text) } : null)

// Where the thread stands, with the words a person needs to act on it; null when it is closed.
function ownerThread(decisions) {
  let state = { question: 'NoAsk', note: 'NoNote' }
  for (const e of decisions) if (Object.hasOwn(THREAD_STEPS, e.kind)) state = THREAD_STEPS[e.kind](state)
  if (state.question === 'NoAsk' && state.note === 'NoNote') return null
  const last = (...kinds) => said(decisions.findLast((e) => kinds.includes(e.kind)))
  return {
    ...state,
    ask: state.question === 'NoAsk' ? null : last('owner-ask'),
    answer: state.question === 'Answered' ? last('owner-answer', 'lead-reply') : null,
    toLead: state.note === 'NoNote' ? null : last('note'),
  }
}

function latestCheck(decisions, evidence) {
  const e = decisions.findLast(isCheck)
  if (!e) return null
  return {
    at: text(e.at),
    by: text(e.by),
    outcome: text(e.outcome),
    answer: text(e.answer),
    p: number(e.p),
    // The task's evidence changed after this check: a fresh check is owed before it counts.
    evidenceSince: !sameEvidence(e, evidence),
  }
}

function blockedBy(task, byId) {
  const out = []
  for (const id of Array.isArray(task.after) ? task.after : []) {
    const dep = byId.get(id)
    if (!dep || dep.status === 'done') continue
    out.push({ id, status: text(dep.status) })
  }
  return out
}

// A timestamp the dashboard can render, or null: a corrupt string must not become "NaN ago".
const when = (value) => (Number.isFinite(parseAt(value)) ? value : null)

// A question to the owner comes first: only the owner (or the lead, once handed) can move it, and done
// waits on it whatever the evidence says.
function gateOf(task, decisions, thread) {
  if (task.status !== 'open' && task.status !== 'claimed') return null
  if (thread?.question === 'Asked') return { why: 'question', entry: { at: thread.ask?.at, tool: null } }
  return ownerGate(decisions, task.evidence)
}

function summarize(task, byId, now) {
  const decisions = entries(task.decisions)
  const thread = ownerThread(decisions)
  const gate = gateOf(task, decisions, thread)
  const signal = when(lastSignal(task))
  const lastChoice = decisions.findLast((e) => e.kind === 'choice')
  return {
    id: task.id,
    status: text(task.status),
    role: text(task.role),
    owner: text(task.owner),
    title: text(task.title) ?? `task ${task.id}`,
    tag: text(task.tag),
    route: text(task.route),
    gated: typeof task.accept === 'string' && task.accept.length > 0,
    after: Array.isArray(task.after) ? task.after.filter((id) => typeof id === 'number') : [],
    blockedBy: blockedBy(task, byId),
    claimedAt: when(task.claimedAt),
    heartbeatAt: when(task.heartbeatAt),
    lastSignalAt: signal,
    silent: task.status === 'claimed' && (signal === null || now - parseAt(signal) >= LIVE_SIGNAL_MS),
    doneAt: when(task.doneAt),
    run: currentRun(task),
    evidenceCount: strings(task.evidence).length,
    check: latestCheck(decisions, task.evidence),
    gate: gate ? { why: gate.why, at: when(gate.entry.at), tool: text(gate.entry.tool) } : null,
    thread,
    // The lead recorded a choice after the gate opened: the gate stands, but someone looked.
    choiceAfterGate: Boolean(gate && lastChoice && parseAt(lastChoice.at) > parseAt(gate.entry.at)),
  }
}

const byDesc = (key) => (a, b) => (parseAt(b[key]) || 0) - (parseAt(a[key]) || 0)

/** The dashboard's view of a parsed board. `now` is a millisecond clock. */
export function boardView(board, now, { cap = LIST_CAP } = {}) {
  if (!board || !Array.isArray(board.tasks)) throw new Error('board has no tasks array')
  const all = board.tasks.filter((t) => t && typeof t === 'object' && typeof t.id === 'number')
  const byId = new Map(all.map((t) => [t.id, t]))
  // Archived rows are stubs kept for ids and dependencies; the board's own list hides them.
  const tasks = all.filter((t) => t.archived !== true)
  const counts = { total: tasks.length, open: 0, claimed: 0, done: 0, cancelled: 0 }
  for (const t of tasks) if (Object.hasOwn(counts, t.status)) counts[t.status] += 1

  const active = tasks.filter((t) => t.status === 'open' || t.status === 'claimed')
  const summaries = active.map((t) => summarize(t, byId, now))
  // A task appears in one section: what needs the owner first, then the rest by claim state.
  const gates = summaries.filter((s) => s.gate).sort(byDesc('lastSignalAt'))
  const claimed = summaries.filter((s) => s.status === 'claimed' && !s.gate)
  const live = claimed.filter((s) => !s.silent).sort(byDesc('lastSignalAt'))
  const silent = claimed.filter((s) => s.silent).sort(byDesc('lastSignalAt'))
  const waiting = summaries.filter((s) => s.status === 'open' && !s.gate).sort((a, b) => b.id - a.id)
  const done = tasks
    .filter((t) => t.status === 'done' && now - parseAt(t.doneAt) < DONE_WINDOW_MS)
    .map((t) => summarize(t, byId, now))
    .sort(byDesc('doneAt'))
  // What the owner handed to the lead and the lead has not answered: a note, or a question passed on.
  // It is not a section of its own; each task also sits in its claim-state section.
  // A finished task can owe a reply too (a cancel waits only for the note to be read).
  const finishedWithNote = tasks
    .filter(
      (t) => (t.status === 'done' || t.status === 'cancelled') && entries(t.decisions).some((e) => e.kind === 'note'),
    )
    .map((t) => summarize(t, byId, now))
  const owed = (s) => s.thread && (s.thread.question === 'HandedToLead' || s.thread.note !== 'NoNote')
  const handedAt = (s) => parseAt(s.thread.toLead?.at ?? s.thread.ask?.at) || 0
  const withLead = [...summaries, ...finishedWithNote].filter(owed).sort((a, b) => handedAt(b) - handedAt(a))

  const list = (items) => items.slice(0, cap)
  return {
    counts: {
      ...counts,
      gates: gates.length,
      live: live.length,
      silent: silent.length,
      waiting: waiting.length,
      doneRecently: done.length,
      questions: gates.filter((s) => s.gate.why === 'question').length,
      withLead: withLead.length,
    },
    gates: list(gates),
    reviewQueue: reviewQueue(
      tasks,
      gates.filter((task) => task.gate.why === 'question'),
    ),
    live: list(live),
    silent: list(silent),
    waiting: list(waiting),
    done: list(done),
    withLead: list(withLead),
  }
}

/**
 * Reads the board file on demand, re-parsing only when its mtime or size changed: the board is
 * over a megabyte and every open dashboard asks every five seconds. A read or parse failure
 * (the board is rewritten whole, so a poll can land mid-write) is reported, not thrown; the
 * dashboard keeps its last good view until the file changes again.
 */
export function createBoardReader(file) {
  let cached = null
  return (now) => {
    const readAt = iso(now)
    let st
    try {
      st = statSync(file)
    } catch (e) {
      return { file, readAt, error: `cannot read the board: ${e.message}` }
    }
    const key = `${st.mtimeMs}:${st.size}`
    try {
      // The parse is cached; the view is not, because "silent" and "done lately" move with the clock.
      if (cached?.key !== key) cached = { key, board: JSON.parse(readFileSync(file, 'utf8')) }
      return { ...boardView(cached.board, now), file, readAt }
    } catch (e) {
      cached = null
      return { file, readAt, error: `cannot read the board: ${e.message}` }
    }
  }
}
