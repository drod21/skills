// The thread's server side: reading one task's journal, and the writes the owner makes from the page. Every write
// goes through `guardWrite` (access, the per-process token, the same-origin check, a bounded JSON body) and then the
// board CLI with an argument array, never a shell. Message text is one argument; the owner's name is fixed here from
// the request's access decision, never read from the body.
import { execFile } from 'node:child_process'
import * as z from 'zod'
import { appState } from './app-state.server'
import { MAX_CLOSED_LIMIT, runBoardView, spawnCli } from './board-cli.server'
import type { Outcome } from './board-cli.server'
import type { Config } from './board-config.server'
import { kickDelivery } from './delivery.server'
import { jsonResponse } from './json-response.server'
import { STATUS, badRequest, failure, guardWrite, outcomeResponse } from './write-guard.server'
import type { BoardView } from '../board/board-contract'
import { jsonParsed } from '../schema'
import {
  AcceptBody,
  LeadBody,
  RetryBody,
  SendBody,
  type Thread,
  type ThreadDelivery,
  type ThreadEntry,
  type ThreadListItem,
} from '../thread/thread-contract'

export type Deps = { config: Config; token: string }

const LIST_TIMEOUT_MS = 20_000
const MAX_LISTED_THREADS = 60
const WRITE_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------- reading a thread

const nullable = <T>(value: T | null | undefined): T | null => value ?? null

const ShownTask = jsonParsed(
  z.object({
    id: z.number().int(),
    title: z.string().nullable().exactOptional(),
    status: z.string(),
    role: z.string().nullable().exactOptional(),
    tag: z.string().nullable().exactOptional(),
    owner: z.string().nullable().exactOptional(),
    archived: z.boolean().exactOptional(),
    decisions: z.array(z.unknown()).exactOptional(),
    deliveries: z.array(z.unknown()).exactOptional(),
  }),
)

const RawEntry = z.object({
  kind: z.string(),
  at: z.string().nullable().exactOptional(),
  by: z.string().nullable().exactOptional(),
  text: z.string().nullable().exactOptional(),
  reason: z.string().nullable().exactOptional(),
  reopened: z.string().nullable().exactOptional(),
})

const RawDelivery = z.object({
  id: z.string(),
  entryKind: z.string(),
  entryAt: z.string(),
  state: z.string(),
  attempts: z.number().exactOptional(),
  audience: z.object({ kind: z.string().exactOptional() }).nullable().exactOptional(),
  threadId: z.string().nullable().exactOptional(),
  nextAttemptAt: z.string().nullable().exactOptional(),
  deliveredAt: z.string().nullable().exactOptional(),
  failedAt: z.string().nullable().exactOptional(),
  error: z.string().nullable().exactOptional(),
  since: z.string().nullable().exactOptional(),
  reason: z.string().nullable().exactOptional(),
})

/** The entries worth a line on the thread, in the board's order. An entry that is not an object is dropped. */
function entriesOf(raw: readonly unknown[] | undefined): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  for (const candidate of raw ?? []) {
    const entry = RawEntry.safeParse(candidate)
    if (!entry.success) continue
    entries.push({
      kind: entry.data.kind,
      at: entry.data.at ?? '',
      by: nullable(entry.data.by),
      text: nullable(entry.data.text),
      reason: nullable(entry.data.reason),
      reopened: nullable(entry.data.reopened),
    })
  }
  return entries
}

/** Outbox records by explicit pick, so the send token a `sending` record carries never reaches the page. */
function deliveriesOf(raw: readonly unknown[] | undefined): ThreadDelivery[] {
  const deliveries: ThreadDelivery[] = []
  for (const candidate of raw ?? []) {
    const record = RawDelivery.safeParse(candidate)
    if (!record.success) continue
    const delivery = record.data
    deliveries.push({
      id: delivery.id,
      entryKind: delivery.entryKind,
      entryAt: delivery.entryAt,
      state: delivery.state,
      attempts: delivery.attempts ?? 0,
      audience: delivery.audience?.kind ?? null,
      threadId: nullable(delivery.threadId),
      nextAttemptAt: nullable(delivery.nextAttemptAt),
      deliveredAt: nullable(delivery.deliveredAt),
      failedAt: nullable(delivery.failedAt),
      error: nullable(delivery.error),
      since: nullable(delivery.since),
      reason: nullable(delivery.reason),
    })
  }
  return deliveries
}

/** `show`'s task and `view`'s derived facts, joined into what the thread page draws. */
export function buildThread(shown: z.infer<typeof ShownTask>, view: BoardView): Thread {
  const card = [...view.tasks, ...view.closed.tasks].find((candidate) => candidate.id === shown.id)
  const holds = view.needsOwner.find((row) => row.id === shown.id)?.reasons ?? []
  // A task on an older closed page is not in `view`: its notes go to the board's lead address, if there is one.
  const boardLead = view.lead ? { source: 'board', threadId: view.lead.threadId } : null
  return {
    revision: view.revision,
    task: {
      id: shown.id,
      title: nullable(shown.title),
      status: shown.status,
      role: nullable(shown.role),
      tag: nullable(shown.tag),
      owner: nullable(shown.owner),
      archived: shown.archived === true,
    },
    thread: card ? card.ownerThread : null,
    reviewRevision: card?.reviewRevision ?? null,
    worker: card?.wake ? { threadId: card.wake.threadId } : null,
    leadAddress: card && card.leadAddress !== undefined ? card.leadAddress : boardLead,
    canAccept: holds.some((reason) => reason.why === 'hold' && reason.canAccept),
    entries: entriesOf(shown.decisions),
    deliveries: deliveriesOf(shown.deliveries),
  }
}

export async function readThread(config: Config, id: number): Promise<Outcome<Thread>> {
  const [shown, view] = await Promise.all([
    spawnCli(config, ['show', String(id)], WRITE_TIMEOUT_MS),
    runBoardView(config, { closedLimit: MAX_CLOSED_LIMIT }),
  ])
  if (shown.failure) return { ok: false, failure: shown.failure }
  if (!view.ok) return view
  const parsed = ShownTask.safeParse(shown.stdout)
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        kind: 'output',
        message: `the board CLI printed a task this app cannot read: ${z.prettifyError(parsed.error)}`,
      },
    }
  }
  return { ok: true, value: buildThread(parsed.data, view.value) }
}

const taskId = (raw: string): number | null => (/^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null)

/** `GET /api/thread/:id`. */
export async function threadResponse(rawId: string, deps: Deps): Promise<Response> {
  const id = taskId(rawId)
  if (id === null) return jsonResponse(failure('refused', 'not a task id'), 404)
  const outcome = await readThread(deps.config, id)
  if (outcome.ok) return jsonResponse({ ok: true, thread: outcome.value })
  const missing = outcome.failure.kind === 'refused' && /does not exist/.test(outcome.failure.message)
  return jsonResponse({ ok: false, failure: outcome.failure }, missing ? 404 : STATUS[outcome.failure.kind])
}

// ---------------------------------------------------------------- the writes

/** Run a write command; on success the board has changed, so ask it to deliver. */
async function writeCommand(config: Config, args: string[], then: number | null | 'none'): Promise<Outcome<null>> {
  const spawned = await spawnCli(config, args, WRITE_TIMEOUT_MS)
  if (spawned.failure) return { ok: false, failure: spawned.failure }
  if (then !== 'none') kickDelivery(config, then)
  return { ok: true, value: null }
}

/** `POST /api/thread/:id/send`: the owner's answer to the open question, or a note to the lead. */
export function sendResponse(request: Request, rawId: string, deps: Deps = appState()): Promise<Response> {
  return guardWrite(request, deps, async ({ actor, body }) => {
    const id = taskId(rawId)
    if (id === null) return jsonResponse(failure('refused', 'not a task id'), 404)
    const input = SendBody.safeParse(body)
    if (!input.success) return badRequest(z.prettifyError(input.error))
    // The flags come before the text, so the text can never be read as one. It is a single argument, trimmed.
    const args = [
      input.data.kind,
      '--by',
      actor,
      ...(input.data.expected ? ['--expected', input.data.expected] : []),
      String(id),
      input.data.text.trim(),
    ]
    return outcomeResponse(await writeCommand(deps.config, args, id))
  })
}

/** `POST /api/thread/:id/retry`: send a delivery that gave up once more. */
export function retryResponse(request: Request, rawId: string, deps: Deps = appState()): Promise<Response> {
  return guardWrite(request, deps, async ({ actor, body }) => {
    const id = taskId(rawId)
    if (id === null) return jsonResponse(failure('refused', 'not a task id'), 404)
    const input = RetryBody.safeParse(body)
    if (!input.success) return badRequest(z.prettifyError(input.error))
    return outcomeResponse(
      await writeCommand(deps.config, ['deliver-retry', '--by', actor, String(id), input.data.deliveryId], id),
    )
  })
}

/** `POST /api/thread/:id/accept`: the owner accepts a held evidence check, with a reason. */
export function acceptResponse(request: Request, rawId: string, deps: Deps = appState()): Promise<Response> {
  return guardWrite(request, deps, async ({ actor, body }) => {
    const id = taskId(rawId)
    if (id === null) return jsonResponse(failure('refused', 'not a task id'), 404)
    const input = AcceptBody.safeParse(body)
    if (!input.success) return badRequest(z.prettifyError(input.error))
    const args = ['accept', '--by', actor, '--reason', input.data.reason.trim(), String(id)]
    return outcomeResponse(await writeCommand(deps.config, args, id))
  })
}

/** `POST /api/thread/lead`: set (or clear) the lead thread for the board, or for one tag. */
export function leadResponse(request: Request, deps: Deps = appState()): Promise<Response> {
  return guardWrite(request, deps, async ({ actor, body }) => {
    const input = LeadBody.safeParse(body)
    if (!input.success) return badRequest(z.prettifyError(input.error))
    const scope = input.data.tag === undefined ? [] : ['--tag', input.data.tag]
    const args =
      input.data.threadId === undefined
        ? ['lead-wake', '--clear', ...scope, '--by', actor]
        : ['lead-wake', ...scope, '--by', actor, input.data.threadId]
    // A message that was waiting for an address may be deliverable now.
    return outcomeResponse(await writeCommand(deps.config, args, null))
  })
}

// ---------------------------------------------------------------- T3 threads, for the picker

const T3Threads = jsonParsed(
  z.array(
    z.object({
      threadId: z.string(),
      title: z.string().nullable().exactOptional(),
      status: z.string().nullable().exactOptional(),
      updatedAt: z.string().nullable().exactOptional(),
      parentThreadId: z.string().nullable().exactOptional(),
    }),
  ),
)

function runT3(config: Config, args: string[]): Promise<Outcome<string>> {
  const signal = AbortSignal.timeout(LIST_TIMEOUT_MS)
  return new Promise((resolve) => {
    execFile(
      config.t3,
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, value: stdout })
        if (signal.aborted) {
          return resolve({ ok: false, failure: { kind: 'timeout', message: 'T3 took too long to list threads' } })
        }
        const line = stderr.trim().split('\n')[0] ?? ''
        resolve({ ok: false, failure: { kind: 'spawn', message: line || `cannot run t3: ${error.message}` } })
      },
    )
  })
}

/** This project's top-level T3 threads, newest first. */
export async function listThreads(config: Config): Promise<Outcome<ThreadListItem[]>> {
  const listed = await runT3(config, ['thread', 'list', '--project', config.project, '--json'])
  if (!listed.ok) return listed
  const parsed = T3Threads.safeParse(listed.value)
  if (!parsed.success) {
    return {
      ok: false,
      failure: { kind: 'output', message: `t3 printed a thread list this app cannot read: ${z.prettifyError(parsed.error)}` },
    }
  }
  const threads = parsed.data
    .filter((thread) => thread.parentThreadId === undefined || thread.parentThreadId === null)
    .slice(0, MAX_LISTED_THREADS)
    .map((thread) => ({
      threadId: thread.threadId,
      title: nullable(thread.title),
      status: nullable(thread.status),
      updatedAt: nullable(thread.updatedAt),
    }))
  return { ok: true, value: threads }
}

/** `GET /api/thread/threads`. */
export async function threadsResponse(deps: Deps = appState()): Promise<Response> {
  const outcome = await listThreads(deps.config)
  return outcome.ok
    ? jsonResponse({ ok: true, threads: outcome.value })
    : jsonResponse({ ok: false, failure: outcome.failure }, STATUS[outcome.failure.kind])
}
