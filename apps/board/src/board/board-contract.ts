// What crosses the two boundaries of the app, written once: the board CLI's `view` JSON (parsed on the server,
// in the module that runs the CLI) and the envelope the server sends the browser (parsed in the browser).
// Types are inferred from the schemas, so a field is added here and nowhere else.
import { type } from 'arktype'

/** The `view` version this app reads. The CLI bumps it when a field changes shape. */
export const SUPPORTED_VIEW_VERSION = 1

const QuestionState = type("'NoAsk' | 'Asked' | 'HandedToLead' | 'Answered'")
const NoteState = type("'NoNote' | 'NoteQueued' | 'NoteRead'")
export const OwnerThread = type({ question: QuestionState, note: NoteState })

const Wake = type({ threadId: 'string', at: 'string' })

// A delivery state or journal kind the CLI adds later is still a string here: the page shows it as plain text
// instead of failing the whole parse.
const Delivery = type({
  id: 'string',
  entryKind: 'string',
  entryAt: 'string',
  attempts: 'number',
  state: 'string',
})

const Message = type({
  kind: 'string',
  at: 'string',
  by: 'string | null',
  text: 'string | null',
  deliveries: Delivery.array(),
})

const Card = type({
  id: 'number.integer',
  title: 'string | null',
  // Any word: a status this app does not know yet is drawn as plain text in the nearest column, never a failed read.
  status: 'string',
  role: 'string | null',
  tag: 'string | null',
  owner: 'string | null',
  route: 'string | null',
  gated: 'boolean',
  archived: 'boolean',
  waitsOn: type({ id: 'number.integer', status: 'string' }).array(),
  claimedAt: 'string | null',
  heartbeatAt: 'string | null',
  lastSignalAt: 'string | null',
  silent: 'boolean',
  closedAt: 'string | null',
  wake: Wake.or('null'),
  // Where this task's notes go. A CLI from before the lead addresses leaves it out.
  'leadAddress?': type({ source: 'string', threadId: 'string' }).or('null'),
  ownerThread: OwnerThread,
  doneBlockers: 'string[]',
  reviewRevision: 'string',
  messages: Message.array(),
  undelivered: 'number.integer >= 0',
})

/** The reasons this app draws in full. Any other word is kept as `other`, with its name, so the board stays readable. */
const KNOWN_REASONS: readonly string[] = ['question', 'hold', 'rejected', 'delivery']

const KnownReason = type({ why: "'question'", text: 'string | null', by: 'string | null', at: 'string | null' })
  .or({ why: "'hold' | 'rejected'", tool: 'string | null', canAccept: 'boolean', at: 'string | null' })
  .or({
    why: "'delivery'",
    id: 'string',
    entryKind: 'string',
    state: 'string',
    detail: 'string | null',
    at: 'string | null',
  })
// A word the lists above do not hold. The narrow keeps a known word with the wrong fields a failed read, as before.
const UnknownReason = type({
  why: type('string').narrow((why) => !KNOWN_REASONS.includes(why)),
  'text?': 'string | null',
})
type OtherReason = { why: 'other'; name: string; text: string | null }

const NeedsReasonSchema = KnownReason.or(UnknownReason).pipe((reason): typeof KnownReason.infer | OtherReason => {
  if (KNOWN_REASONS.includes(reason.why)) return reason as typeof KnownReason.infer
  return { why: 'other', name: reason.why, text: 'text' in reason ? (reason.text ?? null) : null }
})

const NeedsRowSchema = type({
  id: 'number.integer',
  title: 'string | null',
  status: 'string',
  reasons: NeedsReasonSchema.array(),
})

const LeadRowSchema = type({
  id: 'number.integer',
  title: 'string | null',
  status: 'string',
  question: QuestionState,
  note: NoteState,
  text: 'string | null',
  at: 'string | null',
})

const ClosedPage = type({ limit: 'number.integer', tasks: Card.array(), next: 'string | null' })

export const BoardViewSchema = type({
  version: `${SUPPORTED_VIEW_VERSION}`,
  revision: 'string',
  now: 'string',
  lead: Wake.and({ 'by?': 'string' }).or('null'),
  // Tag lead addresses, by tag. A CLI from before them leaves it out.
  'leadTags?': type({ '[string]': Wake.and({ 'by?': 'string' }) }),
  counts: {
    open: 'number.integer',
    claimed: 'number.integer',
    done: 'number.integer',
    cancelled: 'number.integer',
    archived: 'number.integer',
  },
  tasks: Card.array(),
  closed: ClosedPage,
  needsOwner: NeedsRowSchema.array(),
  withLead: LeadRowSchema.array(),
})

export type BoardView = typeof BoardViewSchema.infer
export type BoardCard = typeof Card.infer
export type NeedsRow = typeof NeedsRowSchema.infer
export type NeedsReason = typeof NeedsReasonSchema.infer
export type LeadRow = typeof LeadRowSchema.infer

/** What went wrong reading the board, in words the page can show. */
export const BoardFailureSchema = type({
  kind: "'refused' | 'timeout' | 'spawn' | 'output' | 'version' | 'network'",
  message: 'string',
})
export type BoardFailure = typeof BoardFailureSchema.infer

/** `GET /api/board`: a view, or why there is none. The page keeps its last good view across a failure. */
export const BoardEnvelopeSchema = type({ ok: 'true', view: BoardViewSchema }).or({
  ok: 'false',
  failure: BoardFailureSchema,
})
export type BoardEnvelope = typeof BoardEnvelopeSchema.infer

export const BuildInfoSchema = type({
  sha: 'string',
  behind: "'current' | 'behind' | 'unknown'",
})
export type BuildInfo = typeof BuildInfoSchema.infer

/** The header a write carries the per-process token in. The page reads the token from `/api/session`. */
export const TOKEN_HEADER = 'x-board-token'

/** `GET /api/session`: who the server believes is asking, the per-process write token, and the running build. */
export const SessionSchema = type({ actor: 'string', token: 'string', build: BuildInfoSchema })
export type Session = typeof SessionSchema.infer

/** One `board` server-sent event: the board file's revision after a change. */
export const BoardEvent = type('string.json.parse').pipe(type({ revision: 'string' }))

export const parseBoardEnvelope = type('string.json.parse').pipe(BoardEnvelopeSchema)
export const parseSession = type('string.json.parse').pipe(SessionSchema)
