// Outbox for owner notes and answers. The CLI sends. This module only changes records.
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOARD_OWNER, currentWake, resolveLeadAddress } from './team-tasks.lib.mjs'

const MAX_ATTEMPTS = 6
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 15 * 60_000
const LEASE_MS = 2 * 60_000
const MESSAGE_LIMIT = 2_000
const ERROR_LIMIT = 300
export const DEFAULT_SWEEP_LIMIT = 5

// The path in a delivered message is the board CLI an agent can run: TEAM_TASKS_SCRIPT, else this toolkit's own
// team-tasks.mjs. It never depends on where the board file lives.
export function boardScriptPath() {
  const override = process.env.TEAM_TASKS_SCRIPT
  if (override && override.trim()) return resolve(override.trim())
  return resolve(dirname(fileURLToPath(import.meta.url)), 'team-tasks.mjs')
}

/** Trim stored `--by` / `--reason` text. Blank is absent. */
export function storedText(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * @type {{
 *   entryKind: string
 *   headline: string
 *   leadFallback?: boolean
 *   audiences: (board: any, task: any, entry: any) => { kind: string, threadId?: string }[]
 *   acknowledge: (board: any, task: any) => { label: string, command: string }[]
 * }[]}
 */
const AUDIENCE_RULES = [
  {
    entryKind: 'owner-answer',
    headline: 'The owner answered your question.',
    audiences(_board, task) {
      return [{ kind: currentWake(task) ? 'claim' : 'lead' }]
    },
    acknowledge(_board, task) {
      const owner = storedText(task.owner)
      return owner && /^[\w.][\w.-]*$/.test(owner)
        ? [{ label: 'Acknowledge', command: `answer-read ${task.id} --by ${owner}` }]
        : []
    },
  },
  {
    entryKind: 'accept',
    headline: 'The owner accepted your evidence.',
    audiences(_board, task) {
      return [{ kind: currentWake(task) ? 'claim' : 'lead' }]
    },
    acknowledge(_board, task) {
      const owner = storedText(task.owner)
      return owner && /^[\w.][\w.-]*$/.test(owner)
        ? [{ label: 'Finish', command: `done ${task.id} --owner ${owner}` }]
        : []
    },
  },
  {
    entryKind: 'note',
    headline: 'The owner left a note.',
    audiences(_board, task) {
      return [{ kind: 'lead' }, ...(task.status === 'claimed' && currentWake(task) ? [{ kind: 'claim' }] : [])]
    },
    acknowledge(board, task) {
      const by = leadBy(board, task) ?? 'lead'
      return /^[\w.][\w.-]*$/.test(by)
        ? [
            { label: 'Acknowledge', command: `note-read ${task.id} --by ${by}` },
            { label: 'Reply', command: `lead-reply ${task.id} <reply> --by ${by}` },
          ]
        : []
    },
  },
  {
    entryKind: 'lead-reply',
    headline: 'The lead answered your question.',
    // The lead wrote this reply and the acknowledgement clears the worker's unread-answer gate, so it goes to the
    // claim only. With no wake address the record waits as unaddressed instead of landing on the lead's thread.
    leadFallback: false,
    audiences() {
      return [{ kind: 'claim' }]
    },
    acknowledge(_board, task) {
      const owner = storedText(task.owner)
      return owner && /^[\w.][\w.-]*$/.test(owner)
        ? [{ label: 'Acknowledge', command: `answer-read ${task.id} --by ${owner}` }]
        : []
    },
  },
  ...['release', 'cancel', 'done'].map((entryKind) => ({
    entryKind,
    headline: 'Your claim ended. Stop work on this task.',
    audiences(_board, _task, entry) {
      return entry.wake?.threadId ? [{ kind: 'ended-claim', threadId: entry.wake.threadId }] : []
    },
    acknowledge() {
      return []
    },
  })),
]

function ruleFor(entryKind) {
  return AUDIENCE_RULES.find((candidate) => candidate.entryKind === entryKind) ?? null
}

function leadThreadId(board, task) {
  return resolveLeadAddress(board, task)?.threadId ?? null
}

function leadBy(board, task) {
  return storedText(resolveLeadAddress(board, task)?.by)
}

function mayFallBackToLead(entryKind) {
  return ruleFor(entryKind)?.leadFallback !== false
}

function resolveThread(board, task, audience, entryKind) {
  if (audience?.kind === 'claim') {
    const wake = currentWake(task)?.threadId
    return wake ?? (mayFallBackToLead(entryKind) ? leadThreadId(board, task) : null)
  }
  if (audience?.kind === 'lead') return leadThreadId(board, task)
  if (audience?.kind === 'ended-claim') return audience.threadId
  return null
}

function unaddressedReason(kind) {
  if (kind === 'claim') return 'the claim has no wake address'
  return 'the board has no lead address'
}

function identity(record, attempts = record.attempts) {
  return {
    id: record.id,
    entryAt: record.entryAt,
    entryKind: record.entryKind,
    audience: { ...record.audience },
    attempts,
  }
}

function toPending(record, nextAttemptAt, attempts = record.attempts) {
  return { ...identity(record, attempts), state: 'pending', nextAttemptAt }
}

function toSending(record, { threadId, token, leaseUntil }) {
  return { ...identity(record), state: 'sending', threadId, token, leaseUntil }
}

function toDelivered(record, { threadId, deliveredAt, t3 }) {
  return { ...identity(record), state: 'delivered', threadId, deliveredAt, t3 }
}

function toFailed(record, { threadId, failedAt, error, attempts }) {
  return {
    ...identity(record, attempts),
    state: 'failed',
    failedAt,
    threadId: threadId ?? null,
    error: String(error ?? '').slice(0, ERROR_LIMIT),
  }
}

function toUnaddressed(record, { since, reason }) {
  return { ...identity(record), state: 'unaddressed', since, reason }
}

function backoffMs(attempt) {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
}

function applyFailure(record, { threadId, error, now }) {
  const attempts = record.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    if (record.audience.kind === 'claim' && mayFallBackToLead(record.entryKind)) {
      return toPending({ ...record, audience: { kind: 'lead', originalThreadId: threadId } }, now.toISOString(), 0)
    }
    const detail = record.audience.originalThreadId
      ? `original worker thread ${record.audience.originalThreadId}: ${error}`
      : error
    return toFailed(record, { threadId, failedAt: now.toISOString(), error: detail, attempts })
  }
  return toPending(record, new Date(now.getTime() + backoffMs(attempts)).toISOString(), attempts)
}

function nextDeliveryId(task) {
  const pattern = new RegExp(`^${task.id}-d(\\d+)$`)
  let max = 0
  for (const record of task.deliveries) {
    const match = pattern.exec(String(record?.id ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${task.id}-d${max + 1}`
}

export function enqueueDeliveries(board, task, entry) {
  const rule = ruleFor(entry?.kind)
  if (!rule) return
  if (task.deliveries == null) task.deliveries = []
  if (!Array.isArray(task.deliveries)) throw new Error(`task ${task.id} has deliveries that are not a list`)
  const at = entry.at
  for (const audience of rule.audiences(board, task, entry)) {
    const thread = resolveThread(board, task, audience, entry.kind)
    const shared = { id: nextDeliveryId(task), entryAt: at, entryKind: entry.kind, audience, attempts: 0 }
    task.deliveries.push(
      thread
        ? { ...shared, state: 'pending', nextAttemptAt: at }
        : { ...shared, state: 'unaddressed', since: at, reason: unaddressedReason(audience.kind) },
    )
  }
}

function timeOf(value) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function isDue(value, now) {
  const time = timeOf(value)
  return time !== null && time <= now.getTime()
}

function leaseExpired(value, now) {
  const time = timeOf(value)
  return time === null || time <= now.getTime()
}

function tasksInScope(board, taskId) {
  if (taskId === null) return board.tasks
  const task = board.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`task ${taskId} does not exist`)
  if (task.archived === true) throw new Error(`task ${taskId} is archived`)
  return [task]
}

function refresh(board, task, index, now) {
  const record = task.deliveries[index]
  if (!record || typeof record !== 'object') return
  if (record.state === 'unaddressed') {
    const thread = resolveThread(board, task, record.audience, record.entryKind)
    if (!thread) return
    task.deliveries[index] = toPending(record, now.toISOString())
    return
  }
  if (record.state === 'sending' && leaseExpired(record.leaseUntil, now)) {
    task.deliveries[index] = toPending(record, now.toISOString())
  }
}

const CLAIM_ENDED_NO_WAKE = 'the claim ended before it had a wake address'
const CLAIM_ENDED_UNSENT = 'the claim ended before this message was delivered'

/**
 * @param {any} task
 * @param {any} record
 */
function earlierClaim(task, record) {
  const claimedAt = Date.parse(task.claimedAt)
  const entryAt = Date.parse(record.entryAt)
  return Number.isFinite(claimedAt) && Number.isFinite(entryAt) && entryAt < claimedAt
}

/** @param {any} record */
function openClaimOnly(record) {
  if (!record || record.audience?.kind !== 'claim' || mayFallBackToLead(record.entryKind)) return false
  return record.state === 'pending' || record.state === 'unaddressed' || record.state === 'sending'
}

/**
 * A claim-only record cannot be delivered once its claim is over. Fail it so archive can proceed.
 * @param {any} task
 * @param {Date} now
 */
export function settleClaimOnlyDeliveries(task, now) {
  if (!Array.isArray(task?.deliveries)) return
  for (let index = 0; index < task.deliveries.length; index += 1) {
    const record = task.deliveries[index]
    if (!openClaimOnly(record)) continue
    if (task.status === 'claimed' && !earlierClaim(task, record)) continue
    task.deliveries[index] = toFailed(record, {
      threadId: record.threadId ?? null,
      failedAt: now.toISOString(),
      error: record.state === 'unaddressed' ? CLAIM_ENDED_NO_WAKE : CLAIM_ENDED_UNSENT,
      attempts: record.attempts,
    })
  }
}

function sourceEntry(task, record) {
  const entries = (Array.isArray(task.decisions) ? task.decisions : []).filter(
    (entry) => entry && entry.kind === record.entryKind && entry.at === record.entryAt,
  )
  const same = task.deliveries.filter(
    (candidate) =>
      candidate &&
      candidate.entryKind === record.entryKind &&
      candidate.entryAt === record.entryAt &&
      candidate.audience?.kind === record.audience?.kind,
  )
  return entries[same.indexOf(record)] ?? entries[0] ?? null
}

/** @param {any} entry */
function authorName(entry) {
  const by = storedText(entry?.by)
  if (!by || by === BOARD_OWNER) return 'The owner'
  return by
}

/**
 * @param {string} entryKind
 * @param {any} entry
 */
function headlineFor(entryKind, entry) {
  if (entryKind === 'note') return `${authorName(entry)} left a note.`
  if (entryKind === 'owner-answer') return `${authorName(entry)} answered your question.`
  if (entryKind === 'accept') return `${authorName(entry)} accepted your evidence.`
  if (entryKind === 'lead-reply') {
    const by = storedText(entry?.by)
    return `${!by || by === BOARD_OWNER ? 'The lead' : by} answered your question.`
  }
  return ruleFor(entryKind)?.headline ?? 'There is a message on this task.'
}

/**
 * @param {any} board
 * @param {any} task
 * @param {any} record
 * @param {string} script
 */
function commandLines(board, task, record, script) {
  if (record.entryKind === 'note' && record.audience.kind === 'claim')
    return ['No acknowledgement is needed. The lead owns the reply.']
  // A claim copy that fell back to the lead already failed as the worker's message. It carries no command.
  if (record.entryKind === 'note' && record.audience.originalThreadId) return []
  const rule = ruleFor(record.entryKind)
  return (rule?.acknowledge(board, task) ?? []).map(({ label, command }) => `${label}: node ${script} ${command}`)
}

function messageText(board, task, record, scriptPath) {
  const entry = sourceEntry(task, record)
  const script = /^[\w./-]+$/.test(scriptPath) ? scriptPath : `'${scriptPath.replaceAll("'", "'\\''")}'`
  const show = `node ${script} show ${task.id}`
  return [
    `Team board, task ${task.id}: ${String(task.title).replace(/\s+/g, ' ').slice(0, 200)}`,
    headlineFor(record.entryKind, entry),
    '---',
    String((record.entryKind === 'accept' ? entry?.reason : entry?.text) ?? '').slice(0, MESSAGE_LIMIT),
    '---',
    `Read it:     ${show}`,
    ...commandLines(board, task, record, script),
    `Delivery ${record.id}. If you already handled this delivery, ignore it.`,
  ].join('\n')
}

function dueRecords(tasks, now) {
  const due = []
  for (const task of tasks) {
    if (!Array.isArray(task.deliveries)) continue
    task.deliveries.forEach((record, index) => {
      if (record?.state === 'pending' && isDue(record.nextAttemptAt, now)) due.push({ task, index })
    })
  }
  due.sort((a, b) => a.task.id - b.task.id || a.index - b.index)
  return due
}

export function nextDueAt(board) {
  let earliest = null
  for (const task of board.tasks ?? []) {
    if (!Array.isArray(task.deliveries)) continue
    for (const record of task.deliveries) {
      let at = null
      if (record?.state === 'pending') at = record.nextAttemptAt
      else if (record?.state === 'sending') at = record.leaseUntil
      if (typeof at !== 'string') continue
      if (earliest === null || at < earliest) earliest = at
    }
  }
  return earliest
}

export function prepareSweep(board, { taskId = null, limit, now, scriptPath }) {
  const tasks = tasksInScope(board, taskId)
  for (const task of tasks) {
    settleClaimOnlyDeliveries(task, now)
    if (!Array.isArray(task.deliveries)) continue
    for (let index = 0; index < task.deliveries.length; index += 1) refresh(board, task, index, now)
  }
  const jobs = []
  let failed = 0
  for (const item of dueRecords(tasks, now)) {
    if (jobs.length + failed >= limit) break
    const record = item.task.deliveries[item.index]
    const threadId = resolveThread(board, item.task, record.audience, record.entryKind)
    if (!threadId) {
      item.task.deliveries[item.index] = toUnaddressed(record, {
        since: now.toISOString(),
        reason: unaddressedReason(record.audience?.kind),
      })
      continue
    }
    if (threadId.startsWith('-')) {
      item.task.deliveries[item.index] = toFailed(record, {
        threadId,
        failedAt: now.toISOString(),
        error: `refusing thread id ${JSON.stringify(threadId)}: a thread id must not start with "-"`,
        attempts: record.attempts + 1,
      })
      failed += 1
      continue
    }
    const token = randomBytes(8).toString('hex')
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString()
    const sending = toSending(record, { threadId, token, leaseUntil })
    item.task.deliveries[item.index] = sending
    jobs.push({
      taskId: item.task.id,
      deliveryId: sending.id,
      token,
      threadId,
      message: messageText(board, item.task, sending, scriptPath),
    })
  }
  return { jobs, failed, nextDueAt: nextDueAt(board) }
}

function t3Of(result) {
  const t3 = {}
  if (result.messageId) t3.messageId = result.messageId
  if (result.runId) t3.runId = result.runId
  return t3
}

export function settleSweep(board, results, now) {
  let sent = 0
  let failed = 0
  for (const result of results) {
    const task = board.tasks.find((candidate) => candidate.id === result.taskId)
    if (!task || !Array.isArray(task.deliveries)) continue
    const index = task.deliveries.findIndex((record) => record?.id === result.deliveryId)
    if (index === -1) continue
    const record = task.deliveries[index]
    // A newer lease, or a record that already finished, owns this outcome.
    if (record.state !== 'sending' || record.token !== result.token) continue
    if (result.ok) {
      task.deliveries[index] = toDelivered(record, {
        threadId: result.threadId,
        deliveredAt: now.toISOString(),
        t3: t3Of(result),
      })
      sent += 1
    } else {
      task.deliveries[index] = applyFailure(record, { threadId: result.threadId, error: result.error, now })
      failed += 1
    }
  }
  return { sent, failed, nextDueAt: nextDueAt(board) }
}

export function retryDelivery(board, taskId, deliveryId, by, now = new Date()) {
  if (!storedText(by)) throw new Error('deliver-retry needs --by <name>')
  const task = tasksInScope(board, taskId)[0]
  const index = (task.deliveries ?? []).findIndex((record) => record.id === deliveryId)
  if (index < 0) throw new Error(`delivery ${deliveryId} does not exist`)
  const record = task.deliveries[index]
  if (record.state !== 'failed') throw new Error(`delivery ${deliveryId} is not failed`)
  task.deliveries[index] = toPending(record, now.toISOString(), 0)
  return task.deliveries[index]
}
