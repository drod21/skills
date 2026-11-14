// What crosses the move boundaries, written once. The board CLI's `moves <id>` output is parsed on the server; the
// browser sees a trimmed copy of it (never a command name or an argument list) and sends back a task id, a target
// and the text the move needs. Types are inferred from the schemas.
import { type } from 'arktype'
import { BoardFailureSchema } from '../board/board-contract'

/** The `moves` version this app reads. The CLI bumps it when a field changes shape. */
export const SUPPORTED_MOVES_VERSION = 1

/** Where a card can be dropped, in the order the board's `moves` lists them. `claimed` is In progress. */
export const TARGET_IDS = ['open', 'claimed', 'done', 'cancelled', 'clear'] as const
export type TargetId = (typeof TARGET_IDS)[number]
export const TargetIdSchema = type("'open' | 'claimed' | 'done' | 'cancelled' | 'clear'")

/** The longest text a move may carry: a reason or a note. */
export const MAX_INPUT_LENGTH = 2000

const MoveInput = type({ name: 'string', flag: 'string | null', required: 'boolean', prefill: 'string | null' })

// ---- the board CLI's answer (server only)

const CliMove = type({ command: 'string', args: 'string[]', inputs: MoveInput.array() })

const CliOptionSchema = type({ state: "'here'" })
  .or(CliMove.and({ state: "'legal'", lands: 'string', notifies: 'string[]' }))
  .or(CliMove.and({ state: "'refused'", reason: 'string' }))

export const CliMovesSchema = type({
  version: `${SUPPORTED_MOVES_VERSION}`,
  id: 'number.integer',
  status: 'string',
  archived: 'boolean',
  revision: 'string',
  targets: {
    open: CliOptionSchema,
    claimed: CliOptionSchema,
    done: CliOptionSchema,
    cancelled: CliOptionSchema,
    clear: CliOptionSchema,
  },
})
export type CliMoves = typeof CliMovesSchema.infer
export type CliOption = typeof CliOptionSchema.infer
export const parseCliMoves = type('string.json.parse').pipe(CliMovesSchema)

// ---- what the browser sees

/** One field a move needs from the owner. The flag is the server's business, so it is not sent. */
const FieldSchema = type({ name: 'string', required: 'boolean', prefill: 'string | null' })
export type MoveField = typeof FieldSchema.infer

const OptionSchema = type({ state: "'here'" })
  .or({ state: "'legal'", command: 'string', fields: FieldSchema.array(), notifies: 'string[]' })
  .or({ state: "'refused'", reason: 'string' })
export type MoveOption = typeof OptionSchema.infer

const LookupSchema = type({
  id: 'number.integer',
  status: 'string',
  archived: 'boolean',
  revision: 'string',
  targets: {
    open: OptionSchema,
    claimed: OptionSchema,
    done: OptionSchema,
    cancelled: OptionSchema,
    clear: OptionSchema,
  },
})
export type MovesLookup = typeof LookupSchema.infer

/** `GET /api/moves/<id>`: what the card can do next, or why that is not known. */
const LookupEnvelope = type({ ok: 'true', moves: LookupSchema }).or({ ok: 'false', failure: BoardFailureSchema })
export const parseLookupEnvelope = type('string.json.parse').pipe(LookupEnvelope)

// ---- a move

/** `POST /api/moves/<id>`: the target, the revision the owner was looking at, and the text the move needs. */
export const MoveRequestSchema = type({
  target: TargetIdSchema,
  revision: 'string > 0 & string <= 200',
  'inputs?': 'Record<string, string>',
})
export type MoveRequest = typeof MoveRequestSchema.infer

/** Why a move did not happen: the board said no, the task changed first, the text was wrong, or the board is out of reach. */
export const MOVE_FAILURES = ['refused', 'stale', 'invalid', 'forbidden', 'unavailable'] as const
export type MoveFailureKind = (typeof MOVE_FAILURES)[number]

const MoveOutcomeSchema = type({ ok: 'true', lands: 'string' }).or({
  ok: 'false',
  kind: type.enumerated(...MOVE_FAILURES),
  message: 'string',
})
export type MoveOutcome = typeof MoveOutcomeSchema.infer
export const parseMoveOutcome = type('string.json.parse').pipe(MoveOutcomeSchema)

/** What the app's write guard answers when it turns a request away before any move runs. */
export const parseGuardRefusal = type('string.json.parse').pipe(type({ ok: 'false', failure: BoardFailureSchema }))
