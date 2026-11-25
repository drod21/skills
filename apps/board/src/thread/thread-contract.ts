// What crosses the boundary for a task's thread, written once: the payload the server builds from the board, the bodies
// a write sends, and the envelopes that answer them. Board text (titles, notes, errors) was written by agents and is
// untrusted: it is only ever a string here and React text on the page.
import * as z from 'zod'
import { jsonParsed } from '../schema'
import { BoardFailureSchema, OwnerThread } from '../board/board-contract'

/** The board stores at most 4,000 characters of message text. */
export const MAX_TEXT_CHARS = 4000
const MAX_REASON_CHARS = 1000

// A journal entry the page may show. `kind` is any string: a kind the CLI adds later is shown as plain text.
const EntrySchema = z.object({
  kind: z.string(),
  at: z.string(),
  by: z.string().nullable(),
  text: z.string().nullable(),
  reason: z.string().nullable(),
  reopened: z.string().nullable(),
})
export type ThreadEntry = z.infer<typeof EntrySchema>

// One outbox record. `state` is any string for the same reason; the fields a state carries are null in the others.
const DeliverySchema = z.object({
  id: z.string(),
  entryKind: z.string(),
  entryAt: z.string(),
  state: z.string(),
  attempts: z.number(),
  audience: z.string().nullable(),
  threadId: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  error: z.string().nullable(),
  since: z.string().nullable(),
  reason: z.string().nullable(),
})
export type ThreadDelivery = z.infer<typeof DeliverySchema>

export const ThreadSchema = z.object({
  revision: z.string(),
  task: z.object({
    id: z.number().int(),
    title: z.string().nullable(),
    status: z.string(),
    role: z.string().nullable(),
    tag: z.string().nullable(),
    owner: z.string().nullable(),
    archived: z.boolean(),
  }),
  /** The owner-thread fold from `view`, or null when the task is on an older closed page that was not read. */
  thread: OwnerThread.nullable(),
  /** The revision an answer or note must name, so a changed question refuses it. Null when `view` does not list the task. */
  reviewRevision: z.string().nullable(),
  /** The worker's thread, when the claim has one. */
  worker: z.object({ threadId: z.string() }).nullable(),
  /** Where notes go: the task's own lead thread, its tag's, the board's, or none. */
  leadAddress: z.object({ source: z.string(), threadId: z.string() }).nullable(),
  /** A held check the owner may accept. */
  canAccept: z.boolean(),
  entries: z.array(EntrySchema),
  deliveries: z.array(DeliverySchema),
})
export type Thread = z.infer<typeof ThreadSchema>

export const ThreadEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), thread: ThreadSchema }),
  z.object({ ok: z.literal(false), failure: BoardFailureSchema }),
])
export const parseThreadEnvelope = jsonParsed(ThreadEnvelopeSchema)

/** The answer to a write: it worked, or the board's own words for why it did not. */
export const WriteEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), failure: BoardFailureSchema }),
])
export type WriteEnvelope = z.infer<typeof WriteEnvelopeSchema>
export const parseWriteEnvelope = jsonParsed(WriteEnvelopeSchema)

const ThreadListItemSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type ThreadListItem = z.infer<typeof ThreadListItemSchema>
export const ThreadListEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), threads: z.array(ThreadListItemSchema) }),
  z.object({ ok: z.literal(false), failure: BoardFailureSchema }),
])
export const parseThreadList = jsonParsed(ThreadListEnvelopeSchema)

// ---- request bodies, parsed on the server. The owner's name is never in one: the server signs the write itself.

const taskText = z.string().superRefine((text, ctx) => {
  const trimmed = text.trim()
  if (trimmed === '') {
    ctx.addIssue({ code: 'custom', message: 'must be something to send' })
    return
  }
  if (trimmed.length > MAX_TEXT_CHARS) {
    ctx.addIssue({ code: 'custom', message: `must be at most ${MAX_TEXT_CHARS} characters` })
    return
  }
  if (trimmed.includes('\0')) ctx.addIssue({ code: 'custom', message: 'must be free of the NUL character' })
})

export const SendBody = z.object({
  kind: z.enum(['note', 'answer']),
  text: taskText,
  // The sha-256 review revision of the task, as `view` reports it.
  expected: z.string().regex(/^[0-9a-f]{64}$/).exactOptional(),
})

export const RetryBody = z.object({ deliveryId: z.string().regex(/^[0-9]+-d[0-9]+$/) })

export const AcceptBody = z.object({
  reason: z.string().superRefine((text, ctx) => {
    const trimmed = text.trim()
    if (trimmed === '') {
      ctx.addIssue({ code: 'custom', message: 'must be a reason' })
      return
    }
    if (trimmed.length > MAX_REASON_CHARS)
      ctx.addIssue({ code: 'custom', message: `must be a reason of at most ${MAX_REASON_CHARS} characters` })
  }),
})

/** A T3 thread id as `t3 thread send` takes it: no whitespace, not a flag, at most 512 characters. */
export const THREAD_ID = /^[^\s-]\S{0,511}$/

/** Set the lead address for the whole board, or for one tag; no `threadId` clears it. */
export const LeadBody = z.object({
  threadId: z.string().regex(THREAD_ID).exactOptional(),
  tag: z
    .string()
    .refine((tag) => tag.trim() === tag && tag !== '' && tag.length <= 200 && !tag.startsWith('-'), 'must be a tag')
    .exactOptional(),
})
