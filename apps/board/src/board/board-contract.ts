// What crosses the two boundaries of the app, written once: the board CLI's `view` JSON (parsed on the server,
// in the module that runs the CLI) and the envelope the server sends the browser (parsed in the browser).
// Types are inferred from the schemas, so a field is added here and nowhere else.
import * as z from 'zod'
import { jsonParsed } from '../schema'

/** The `view` version this app reads. The CLI bumps it when a field changes shape. */
export const SUPPORTED_VIEW_VERSION = 1

const QuestionState = z.enum(['NoAsk', 'Asked', 'HandedToLead', 'Answered'])
const NoteState = z.enum(['NoNote', 'NoteQueued', 'NoteRead'])
export const OwnerThread = z.object({ question: QuestionState, note: NoteState })

const Wake = z.object({ threadId: z.string(), at: z.string() })
const WakeBy = Wake.extend({ by: z.string().exactOptional() })

// A delivery state or journal kind the CLI adds later is still a string here: the page shows it as plain text
// instead of failing the whole parse.
const Delivery = z.object({
  id: z.string(),
  entryKind: z.string(),
  entryAt: z.string(),
  attempts: z.number(),
  state: z.string(),
})

const Message = z.object({
  kind: z.string(),
  at: z.string(),
  by: z.string().nullable(),
  text: z.string().nullable(),
  deliveries: z.array(Delivery),
})

const LeadAddress = z.object({ source: z.string(), threadId: z.string() })

const Card = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  // Any word: a status this app does not know yet is drawn as plain text in the nearest column, never a failed read.
  status: z.string(),
  role: z.string().nullable(),
  tag: z.string().nullable(),
  owner: z.string().nullable(),
  route: z.string().nullable(),
  gated: z.boolean(),
  archived: z.boolean(),
  waitsOn: z.array(z.object({ id: z.number().int(), status: z.string() })),
  claimedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  lastSignalAt: z.string().nullable(),
  silent: z.boolean(),
  closedAt: z.string().nullable(),
  wake: Wake.nullable(),
  // Where this task's notes go. A CLI from before the lead addresses leaves it out.
  leadAddress: LeadAddress.nullable().exactOptional(),
  ownerThread: OwnerThread,
  doneBlockers: z.array(z.string()),
  reviewRevision: z.string(),
  messages: z.array(Message),
  // Every outbox record, an accept included. A CLI from before the card listed them leaves it out.
  deliveries: z.array(Delivery).exactOptional(),
  undelivered: z.number().int().nonnegative(),
})

/** The reasons this app draws in full. Any other word is kept as `other`, with its name, so the board stays readable. */
const KNOWN_REASONS = new Set<string>(['question', 'hold', 'rejected', 'delivery'])

const KnownReason = z.union([
  z.object({
    why: z.literal('question'),
    text: z.string().nullable(),
    by: z.string().nullable(),
    at: z.string().nullable(),
  }),
  z.object({
    why: z.enum(['hold', 'rejected']),
    tool: z.string().nullable(),
    canAccept: z.boolean(),
    at: z.string().nullable(),
  }),
  z.object({
    why: z.literal('delivery'),
    id: z.string(),
    entryKind: z.string(),
    state: z.string(),
    detail: z.string().nullable(),
    at: z.string().nullable(),
  }),
])
// A word the lists above do not hold. The check keeps a known word with the wrong fields a failed read, as before.
const UnknownReason = z.object({
  why: z.string().refine((why) => !KNOWN_REASONS.has(why)),
  text: z.string().nullable().exactOptional(),
})
type OtherReason = { why: 'other'; name: string; text: string | null }
type KnownReasonOut = z.infer<typeof KnownReason>

const NeedsReasonSchema = z.union([KnownReason, UnknownReason]).transform((reason): KnownReasonOut | OtherReason => {
  if (KNOWN_REASONS.has(reason.why)) return reason as KnownReasonOut
  return { why: 'other', name: reason.why, text: 'text' in reason ? (reason.text ?? null) : null }
})

const NeedsRowSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  status: z.string(),
  reasons: z.array(NeedsReasonSchema),
})

const LeadRowSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  status: z.string(),
  question: QuestionState,
  note: NoteState,
  text: z.string().nullable(),
  at: z.string().nullable(),
})

const ClosedPage = z.object({
  limit: z.number().int(),
  tasks: z.array(Card),
  next: z.string().nullable(),
})

export const BoardViewSchema = z.object({
  version: z.literal(SUPPORTED_VIEW_VERSION),
  revision: z.string(),
  now: z.string(),
  lead: WakeBy.nullable(),
  // Tag lead addresses, by tag. A CLI from before them leaves it out.
  leadTags: z.record(z.string(), WakeBy).exactOptional(),
  counts: z.object({
    open: z.number().int(),
    claimed: z.number().int(),
    done: z.number().int(),
    cancelled: z.number().int(),
    archived: z.number().int(),
  }),
  tasks: z.array(Card),
  closed: ClosedPage,
  needsOwner: z.array(NeedsRowSchema),
  withLead: z.array(LeadRowSchema),
})

export type BoardView = z.infer<typeof BoardViewSchema>
export type BoardCard = z.infer<typeof Card>
export type NeedsRow = z.infer<typeof NeedsRowSchema>
export type NeedsReason = z.infer<typeof NeedsReasonSchema>
export type LeadRow = z.infer<typeof LeadRowSchema>

/** What went wrong reading the board, in words the page can show. */
export const BoardFailureSchema = z.object({
  kind: z.enum(['refused', 'timeout', 'spawn', 'output', 'version', 'network']),
  message: z.string(),
})
export type BoardFailure = z.infer<typeof BoardFailureSchema>

/** `GET /api/board`: a view, or why there is none. The page keeps its last good view across a failure. */
export const BoardEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), view: BoardViewSchema }),
  z.object({ ok: z.literal(false), failure: BoardFailureSchema }),
])
export type BoardEnvelope = z.infer<typeof BoardEnvelopeSchema>

export const BuildInfoSchema = z.object({
  sha: z.string(),
  behind: z.enum(['current', 'behind', 'unknown']),
})
export type BuildInfo = z.infer<typeof BuildInfoSchema>

/** The header a write carries the per-process token in. The page reads the token from `/api/session`. */
export const TOKEN_HEADER = 'x-board-token'

/** `GET /api/session`: who the server believes is asking, the per-process write token, and the running build. */
export const SessionSchema = z.object({ actor: z.string(), token: z.string(), build: BuildInfoSchema })
export type Session = z.infer<typeof SessionSchema>

/** One `board` server-sent event: the board file's revision after a change. */
export const BoardEvent = jsonParsed(z.object({ revision: z.string() }))

export const parseBoardEnvelope = jsonParsed(BoardEnvelopeSchema)
export const parseSession = jsonParsed(SessionSchema)
