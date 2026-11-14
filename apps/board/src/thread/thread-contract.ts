// What crosses the boundary for a task's thread, written once: the payload the server builds from the board, the bodies
// a write sends, and the envelopes that answer them. Board text (titles, notes, errors) was written by agents and is
// untrusted: it is only ever a string here and React text on the page.
import { type } from 'arktype'
import { BoardFailureSchema, OwnerThread } from '../board/board-contract'

/** The board stores at most 4,000 characters of message text. */
export const MAX_TEXT_CHARS = 4000
const MAX_REASON_CHARS = 1000

// A journal entry the page may show. `kind` is any string: a kind the CLI adds later is shown as plain text.
const EntrySchema = type({
  kind: 'string',
  at: 'string',
  by: 'string | null',
  text: 'string | null',
  reason: 'string | null',
  reopened: 'string | null',
})
export type ThreadEntry = typeof EntrySchema.infer

// One outbox record. `state` is any string for the same reason; the fields a state carries are null in the others.
const DeliverySchema = type({
  id: 'string',
  entryKind: 'string',
  entryAt: 'string',
  state: 'string',
  attempts: 'number',
  audience: 'string | null',
  threadId: 'string | null',
  nextAttemptAt: 'string | null',
  deliveredAt: 'string | null',
  failedAt: 'string | null',
  error: 'string | null',
  since: 'string | null',
  reason: 'string | null',
})
export type ThreadDelivery = typeof DeliverySchema.infer

export const ThreadSchema = type({
  revision: 'string',
  task: {
    id: 'number.integer',
    title: 'string | null',
    status: 'string',
    role: 'string | null',
    tag: 'string | null',
    owner: 'string | null',
    archived: 'boolean',
  },
  /** The owner-thread fold from `view`, or null when the task is on an older closed page that was not read. */
  thread: OwnerThread.or('null'),
  /** The revision an answer or note must name, so a changed question refuses it. Null when `view` does not list the task. */
  reviewRevision: 'string | null',
  /** The worker's thread, when the claim has one. */
  worker: type({ threadId: 'string' }).or('null'),
  /** Where notes go: the task's own lead thread, its tag's, the board's, or none. */
  leadAddress: type({ source: 'string', threadId: 'string' }).or('null'),
  /** A held check the owner may accept. */
  canAccept: 'boolean',
  entries: EntrySchema.array(),
  deliveries: DeliverySchema.array(),
})
export type Thread = typeof ThreadSchema.infer

export const ThreadEnvelopeSchema = type({ ok: 'true', thread: ThreadSchema }).or({
  ok: 'false',
  failure: BoardFailureSchema,
})
export const parseThreadEnvelope = type('string.json.parse').pipe(ThreadEnvelopeSchema)

/** The answer to a write: it worked, or the board's own words for why it did not. */
export const WriteEnvelopeSchema = type({ ok: 'true' }).or({ ok: 'false', failure: BoardFailureSchema })
export type WriteEnvelope = typeof WriteEnvelopeSchema.infer
export const parseWriteEnvelope = type('string.json.parse').pipe(WriteEnvelopeSchema)

const ThreadListItemSchema = type({
  threadId: 'string',
  title: 'string | null',
  status: 'string | null',
  updatedAt: 'string | null',
})
export type ThreadListItem = typeof ThreadListItemSchema.infer
export const ThreadListEnvelopeSchema = type({ ok: 'true', threads: ThreadListItemSchema.array() }).or({
  ok: 'false',
  failure: BoardFailureSchema,
})
export const parseThreadList = type('string.json.parse').pipe(ThreadListEnvelopeSchema)

// ---- request bodies, parsed on the server. The owner's name is never in one: the server signs the write itself.

const taskText = type('string').narrow((text, ctx) => {
  const trimmed = text.trim()
  if (trimmed === '') return ctx.mustBe('something to send')
  if (trimmed.length > MAX_TEXT_CHARS) return ctx.mustBe(`at most ${MAX_TEXT_CHARS} characters`)
  return !trimmed.includes('\0') || ctx.mustBe('free of the NUL character')
})

export const SendBody = type({
  kind: "'note' | 'answer'",
  text: taskText,
  // The sha-256 review revision of the task, as `view` reports it.
  'expected?': /^[0-9a-f]{64}$/,
})

export const RetryBody = type({ deliveryId: /^[0-9]+-d[0-9]+$/ })

export const AcceptBody = type({
  reason: type('string').narrow((text, ctx) => {
    const trimmed = text.trim()
    if (trimmed === '') return ctx.mustBe('a reason')
    return trimmed.length <= MAX_REASON_CHARS || ctx.mustBe(`a reason of at most ${MAX_REASON_CHARS} characters`)
  }),
})

/** A T3 thread id as `t3 thread send` takes it: no whitespace, not a flag, at most 512 characters. */
export const THREAD_ID = /^[^\s-]\S{0,511}$/

/** Set the lead address for the whole board, or for one tag; no `threadId` clears it. */
export const LeadBody = type({
  'threadId?': THREAD_ID,
  'tag?': type('string').narrow((tag, ctx) => {
    return (tag.trim() === tag && tag !== '' && tag.length <= 200 && !tag.startsWith('-')) || ctx.mustBe('a tag')
  }),
})
