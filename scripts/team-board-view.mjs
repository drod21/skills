// The kanban's read model. `view` is the whole board as the app renders it and `moves` is what a card can do next.
// Both are built from the library's own functions (ownerThread, doneBlockers, ownerGate, currentWake, staleClaims,
// archiveRefusal and the commands themselves), so the app never carries a second copy of a rule. Nothing here writes.
import {
  archiveRefusal,
  BOARD_OWNER,
  cancelTask,
  claimTask,
  currentRun,
  currentWake,
  doneBlockers,
  doneTask,
  lastSignal,
  mergedTask,
  noteToLead,
  ownerGate,
  ownerThread,
  releaseTask,
  resolveLeadAddress,
  staleClaims,
} from './team-tasks.lib.mjs'
import { reviewRevision } from './review-queue.mjs'

/** Bump when a field the app reads changes shape. */
export const VIEW_VERSION = 1
export const DEFAULT_CLOSED_LIMIT = 50
const SILENT_HOURS = 24
const FINISHED = ['done', 'cancelled']
const MESSAGE_KINDS = ['owner-ask', 'owner-answer', 'note', 'lead-reply']

// ---------------------------------------------------------------- cards

const decisionsOf = (task) => (Array.isArray(task.decisions) ? task.decisions : [])

/** The outbox record as the app may see it: its state and the facts that state carries, never the send token. */
function deliveryOf(record) {
  const base = {
    id: record.id,
    entryKind: record.entryKind,
    entryAt: record.entryAt,
    audience: record.audience,
    attempts: record.attempts,
    state: record.state,
  }
  switch (record.state) {
    case 'pending':
      return { ...base, nextAttemptAt: record.nextAttemptAt }
    case 'sending':
      return { ...base, threadId: record.threadId, leaseUntil: record.leaseUntil }
    case 'delivered':
      return { ...base, threadId: record.threadId, deliveredAt: record.deliveredAt, t3: record.t3 }
    case 'failed':
      return { ...base, threadId: record.threadId, failedAt: record.failedAt, error: record.error }
    case 'unaddressed':
      return { ...base, since: record.since, reason: record.reason }
    default:
      return base
  }
}

function messagesOf(task, deliveries) {
  return decisionsOf(task)
    .filter((entry) => MESSAGE_KINDS.includes(entry?.kind))
    .map((entry) => ({
      kind: entry.kind,
      at: entry.at,
      by: entry.by ?? null,
      text: entry.text ?? null,
      ...(entry.reopened ? { reopened: entry.reopened } : {}),
      deliveries: deliveries.filter((record) => record.entryKind === entry.kind && record.entryAt === entry.at),
    }))
}

function runOf(task) {
  const run = currentRun(task)
  return run ? { kind: run.kind, ref: run.ref } : null
}

function waitsOn(task, byId) {
  return (Array.isArray(task.after) ? task.after : [])
    .filter((id) => byId.get(id)?.status !== 'done')
    .map((id) => ({ id, status: byId.get(id)?.status ?? 'missing' }))
}

function closedAt(task) {
  if (task.status === 'done') return typeof task.doneAt === 'string' ? task.doneAt : null
  const cancel = decisionsOf(task).findLast((entry) => entry?.kind === 'cancel')
  return typeof cancel?.at === 'string' ? cancel.at : null
}

/** The fields that say what a task is and who has it. */
function identityOf(task) {
  return {
    id: task.id,
    title: task.title ?? null,
    status: task.status,
    role: task.role ?? null,
    tag: task.tag ?? null,
    owner: task.owner ?? null,
    route: task.route ?? null,
    gated: typeof task.accept === 'string' && task.accept.length > 0,
    accept: task.accept ?? null,
    archived: task.archived === true,
  }
}

/** The fields that say where the task is in its life: waits, claim, signals, close. */
function progressOf(task, { byId, silent }) {
  return {
    after: Array.isArray(task.after) ? task.after : [],
    waitsOn: waitsOn(task, byId),
    claimedAt: task.claimedAt ?? null,
    heartbeatAt: task.heartbeatAt ?? null,
    lastSignalAt: lastSignal(task),
    silent: silent.has(task.id),
    doneAt: task.doneAt ?? null,
    closedAt: FINISHED.includes(task.status) ? closedAt(task) : null,
    wake: currentWake(task),
    leadWake: task.leadWake ?? null,
    run: runOf(task),
    evidenceCount: Array.isArray(task.evidence) ? task.evidence.length : 0,
  }
}

/**
 * @param {any} board
 * @param {any} task
 */
function leadAddressOf(board, task) {
  const resolved = resolveLeadAddress(board, task)
  if (!resolved) return null
  return { source: resolved.source, threadId: resolved.threadId, at: resolved.at ?? null, by: resolved.by ?? null }
}

/** @param {any} board */
function leadTagsOf(board) {
  const tags = board.tagLeadWakes
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return {}
  return { ...tags }
}

function cardOf(task, context) {
  const deliveries = (Array.isArray(task.deliveries) ? task.deliveries : []).map(deliveryOf)
  return {
    ...identityOf(task),
    ...progressOf(task, context),
    leadAddress: leadAddressOf(context.board, task),
    ownerThread: ownerThread(task),
    doneBlockers: doneBlockers(task),
    reviewRevision: reviewRevision(task),
    messages: messagesOf(task, deliveries),
    deliveries,
    undelivered: deliveries.filter((record) => record.state !== 'delivered').length,
  }
}

// ---------------------------------------------------------------- needs the owner, with the lead

function gateReason({ why, tool, entry }) {
  const at = entry?.at ?? null
  if (why === 'question') return { why, text: entry?.text ?? null, by: entry?.by ?? null, at }
  return { why, tool, canAccept: why === 'hold' && tool === 'check', at }
}

function deliveryReason(record) {
  return {
    why: 'delivery',
    id: record.id,
    entryKind: record.entryKind,
    state: record.state,
    detail: record.state === 'failed' ? record.error : record.reason,
    at: record.state === 'failed' ? record.failedAt : record.since,
  }
}

function ownerReasons(task) {
  const gate = ownerGate(task)
  const stuck = (Array.isArray(task.deliveries) ? task.deliveries : []).filter(
    (record) => record.state === 'failed' || record.state === 'unaddressed',
  )
  return [...(gate ? [gateReason(gate)] : []), ...stuck.map(deliveryReason)]
}

const latestText = (task, kind) => decisionsOf(task).findLast((entry) => entry?.kind === kind)?.text ?? null

/** What the owner handed to the lead that the lead has not answered: a note, or a question passed on with one. */
function leadRow(task) {
  const { question, note } = ownerThread(task)
  if (question !== 'HandedToLead' && note === 'NoNote') return null
  const handed = decisionsOf(task).findLast((entry) => entry?.kind === 'note')
  return {
    id: task.id,
    title: task.title ?? null,
    status: task.status,
    question,
    note,
    text: latestText(task, 'note'),
    at: handed?.at ?? null,
  }
}

// ---------------------------------------------------------------- the closed page

/** A cursor names the last card of a page: its close time in milliseconds (or none) and its id. */
function cursorOf(card) {
  const at = card.closedAt === null ? Number.NaN : Date.parse(card.closedAt)
  return `${Number.isFinite(at) ? at : 'none'}:${card.id}`
}

function readCursor(raw) {
  const match = typeof raw === 'string' ? /^(-?\d+|none):(\d+)$/.exec(raw) : null
  if (!match) throw new Error('--closed-before must be a cursor from a previous view')
  return { at: match[1] === 'none' ? Number.NEGATIVE_INFINITY : Number(match[1]), id: Number(match[2]) }
}

function closeKey(card) {
  const at = card.closedAt === null ? Number.NaN : Date.parse(card.closedAt)
  return { at: Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY, id: card.id }
}

// Newest first, then the higher id. A task with no close time sorts after every task with one.
const newerFirst = (left, right) => {
  const a = closeKey(left)
  const b = closeKey(right)
  return a.at === b.at ? b.id - a.id : a.at > b.at ? -1 : 1
}

function closedPage(cards, { limit, before }) {
  const sorted = [...cards].sort(newerFirst)
  const after =
    before === null
      ? sorted
      : sorted.filter((card) => {
          const key = closeKey(card)
          return key.at < before.at || (key.at === before.at && key.id < before.id)
        })
  const page = after.slice(0, limit)
  return { limit, tasks: page, next: after.length > limit ? cursorOf(page[page.length - 1]) : null }
}

// ---------------------------------------------------------------- view

function filtered({ role, tag, owner }) {
  return (task) =>
    (role == null || task.role === role) && (tag == null || task.tag === tag) && (owner == null || task.owner === owner)
}

/**
 * The projection the app renders. `archived` maps ids to archive lines so a stub shows its task; `revision` is the
 * file's mtime and size. Filters narrow the task lists and the two owner lists, never the counts.
 */
export function buildView(
  board,
  {
    now,
    revision,
    archived = new Map(),
    role = null,
    tag = null,
    owner = null,
    closedLimit = DEFAULT_CLOSED_LIMIT,
    closedBefore = null,
  },
) {
  const before = closedBefore === null ? null : readCursor(closedBefore)
  const whole = board.tasks.map((task) => mergedTask(task, archived))
  const byId = new Map(board.tasks.map((task) => [task.id, task]))
  const silent = new Set(staleClaims(board, { hours: SILENT_HOURS, now }).map((claim) => claim.id))
  const card = (task) => cardOf(task, { byId, silent, board })
  const matches = filtered({ role, tag, owner })
  const live = board.tasks.filter((task) => task.archived !== true)
  const counts = { open: 0, claimed: 0, done: 0, cancelled: 0, archived: 0 }
  for (const task of board.tasks) {
    if (Object.hasOwn(counts, task.status)) counts[task.status] += 1
    if (task.archived === true) counts.archived += 1
  }
  const needsOwner = live
    .filter(matches)
    .map((task) => ({ task, reasons: ownerReasons(task) }))
    .filter(({ reasons }) => reasons.length)
    .map(({ task, reasons }) => ({ id: task.id, title: task.title ?? null, status: task.status, reasons }))
  return {
    version: VIEW_VERSION,
    revision,
    now: now.toISOString(),
    lead: board.leadWake ?? null,
    leadTags: leadTagsOf(board),
    counts,
    tasks: live
      .filter((task) => task.status === 'open' || task.status === 'claimed')
      .filter(matches)
      .map(card),
    closed: closedPage(
      whole
        .filter((task) => FINISHED.includes(task.status))
        .filter(matches)
        .map(card),
      { limit: closedLimit, before },
    ),
    needsOwner,
    withLead: live.filter(matches).map(leadRow).filter(Boolean),
  }
}

// ---------------------------------------------------------------- moves

/** The targets a card can be dropped on. `clear` takes the card off the active board. */
export const MOVE_TARGETS = ['open', 'claimed', 'done', 'cancelled', 'clear']

const text = (prefill) => ({ name: 'text', flag: null, required: true, prefill })
const reason = (required) => ({ name: 'reason', flag: '--reason', required, prefill: null })
// What a dry run types into an input the caller has not filled yet.
const TRIAL_TEXT = 'Moved from the kanban'

/** @param {((task: { id: number }) => string) | null} prefill the start note for the move, or null for the owner to type */
function noteMove(prefill) {
  return ({ task, by }) => ({
    command: 'note',
    args: ['note', String(task.id), '--by', by, '--expected', reviewRevision(task)],
    inputs: [text(prefill?.(task) ?? null)],
    run: (board, { now }) =>
      noteToLead(board, task.id, { text: prefill?.(task) ?? TRIAL_TEXT, by, expected: reviewRevision(task), now }),
  })
}

const stop =
  (command, run, input) =>
  ({ task, by }) => ({
    command,
    args: [command, String(task.id), '--by', by],
    inputs: input ? [input] : [],
    run: (board, { now }) => run(board, task.id, { by, reason: input ? TRIAL_TEXT : null, now }),
  })

const MOVES = {
  start: noteMove((task) => `Please start task ${task.id}`),
  reopen: noteMove(null),
  release: stop('release', releaseTask, reason(false)),
  cancel: stop('cancel', cancelTask, reason(true)),
  done: ({ task, by }) => ({
    command: 'done',
    args: ['done', String(task.id), '--by', by],
    inputs: [],
    run: (board, { now }) => doneTask(board, task.id, { by, now }),
  }),
  claim: ({ task, by }) => ({
    command: 'claim',
    args: ['claim', task.role ?? 'lead', by, '--id', String(task.id)],
    inputs: [],
    run: (board) => claimTask(board, task.role, by, { id: task.id }),
  }),
  archive: ({ task }) => ({
    command: 'archive',
    args: ['archive', '--id', String(task.id)],
    inputs: [],
    lands: 'archived',
    run: () => {
      const refusal = archiveRefusal(task)
      if (refusal) throw new Error(refusal)
    },
  }),
}

const HERE = null

// From the card's status to each target. This is the only place the mapping lives.
const MOVE_TABLE = {
  open: { open: HERE, claimed: 'start', done: 'done', cancelled: 'cancel', clear: 'cancel' },
  claimed: { open: 'release', claimed: HERE, done: 'done', cancelled: 'cancel', clear: 'cancel' },
  done: { open: 'reopen', claimed: 'claim', done: HERE, cancelled: 'cancel', clear: 'archive' },
  cancelled: { open: 'reopen', claimed: 'claim', done: 'done', cancelled: HERE, clear: 'archive' },
}

/**
 * Runs the command on a copy of this one task. The board's other tasks are read, never cloned, so the refusal
 * is the board's own words and nothing is written.
 */
function trial(board, task, { run, lands }, now) {
  const copy = structuredClone(task)
  const before = Array.isArray(copy.deliveries) ? copy.deliveries.length : 0
  const sandbox = { ...board, tasks: board.tasks.map((candidate) => (candidate === task ? copy : candidate)) }
  try {
    run(sandbox, { now })
  } catch (error) {
    return { state: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
  const sent = (Array.isArray(copy.deliveries) ? copy.deliveries : []).slice(before)
  return { state: 'legal', lands: lands ?? copy.status, notifies: sent.map((record) => record.audience.kind) }
}

function moveOf(board, task, key, { by, now }) {
  const { run, lands, ...shown } = MOVES[key]({ task, by })
  return { ...shown, ...trial(board, task, { run, lands }, now) }
}

/** For each target, `here`, or the command with the inputs it needs and what it does, or the board's refusal. */
export function buildMoves(board, id, { by = BOARD_OWNER, now }) {
  const task = board.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`task ${id} does not exist`)
  const row = MOVE_TABLE[task.status]
  const targets = Object.fromEntries(
    MOVE_TARGETS.map((target) => [
      target,
      row[target] === HERE ? { state: 'here' } : moveOf(board, task, row[target], { by, now }),
    ]),
  )
  return {
    version: VIEW_VERSION,
    id,
    by,
    status: task.status,
    archived: task.archived === true,
    revision: reviewRevision(task),
    targets,
  }
}
