// What crosses the move boundaries, written once. The board CLI's `moves <id>` output is parsed on the server; the
// browser sees a trimmed copy of it (never a command name or an argument list) and sends back a task id, a target
// and the text the move needs. Types are inferred from the schemas.
import * as z from 'zod'
import { jsonParsed } from '../schema'
import { BoardFailureSchema } from '../board/board-contract'

/** The `moves` version this app reads. The CLI bumps it when a field changes shape. */
export const SUPPORTED_MOVES_VERSION = 1

/** Where a card can be dropped, in the order the board's `moves` lists them. `claimed` is In progress. */
export const TARGET_IDS = ['open', 'claimed', 'done', 'cancelled', 'clear'] as const
export type TargetId = (typeof TARGET_IDS)[number]
export const TargetIdSchema = z.enum(TARGET_IDS)

/** The longest text a move may carry: a reason or a note. */
export const MAX_INPUT_LENGTH = 2000

const MoveInput = z.object({
  name: z.string(),
  flag: z.string().nullable(),
  required: z.boolean(),
  prefill: z.string().nullable(),
})

// ---- the board CLI's answer (server only)

const CliMove = z.object({ command: z.string(), args: z.array(z.string()), inputs: z.array(MoveInput) })

const CliOptionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('here') }),
  CliMove.extend({ state: z.literal('legal'), lands: z.string(), notifies: z.array(z.string()) }),
  CliMove.extend({ state: z.literal('refused'), reason: z.string() }),
])

const targets = <T extends z.ZodType>(option: T) =>
  z.object({
    open: option,
    claimed: option,
    done: option,
    cancelled: option,
    clear: option,
  })

export const CliMovesSchema = z.object({
  version: z.literal(SUPPORTED_MOVES_VERSION),
  id: z.number().int(),
  status: z.string(),
  archived: z.boolean(),
  revision: z.string(),
  targets: targets(CliOptionSchema),
})
export type CliMoves = z.infer<typeof CliMovesSchema>
export type CliOption = z.infer<typeof CliOptionSchema>
export const parseCliMoves = jsonParsed(CliMovesSchema)

// ---- what the browser sees

/** One field a move needs from the owner. The flag is the server's business, so it is not sent. */
const FieldSchema = z.object({ name: z.string(), required: z.boolean(), prefill: z.string().nullable() })
export type MoveField = z.infer<typeof FieldSchema>

const OptionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('here') }),
  z.object({
    state: z.literal('legal'),
    command: z.string(),
    fields: z.array(FieldSchema),
    notifies: z.array(z.string()),
  }),
  z.object({ state: z.literal('refused'), reason: z.string() }),
])
export type MoveOption = z.infer<typeof OptionSchema>

const LookupSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  archived: z.boolean(),
  revision: z.string(),
  targets: targets(OptionSchema),
})
export type MovesLookup = z.infer<typeof LookupSchema>

/** `GET /api/moves/<id>`: what the card can do next, or why that is not known. */
const LookupEnvelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), moves: LookupSchema }),
  z.object({ ok: z.literal(false), failure: BoardFailureSchema }),
])
export const parseLookupEnvelope = jsonParsed(LookupEnvelope)

// ---- a move

/** `POST /api/moves/<id>`: the target, the revision the owner was looking at, and the text the move needs. */
export const MoveRequestSchema = z.object({
  target: TargetIdSchema,
  revision: z.string().min(1).max(200),
  inputs: z.record(z.string(), z.string()).exactOptional(),
})
export type MoveRequest = z.infer<typeof MoveRequestSchema>

/** Why a move did not happen: the board said no, the task changed first, the text was wrong, or the board is out of reach. */
export const MOVE_FAILURES = ['refused', 'stale', 'invalid', 'forbidden', 'unavailable'] as const
export type MoveFailureKind = (typeof MOVE_FAILURES)[number]

const MoveOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), lands: z.string() }),
  z.object({ ok: z.literal(false), kind: z.enum(MOVE_FAILURES), message: z.string() }),
])
export type MoveOutcome = z.infer<typeof MoveOutcomeSchema>
export const parseMoveOutcome = jsonParsed(MoveOutcomeSchema)

/** What the app's write guard answers when it turns a request away before any move runs. */
export const parseGuardRefusal = jsonParsed(z.object({ ok: z.literal(false), failure: BoardFailureSchema }))
