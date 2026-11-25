// Moves, server side. The browser names a task, a target and the text the move needs; this module asks the board
// CLI what that move is right now (`moves <id>`), checks the card is the one the owner looked at, builds the argument
// array itself and runs it through the same bridge that reads the view. A command name or an argument list from the
// browser is never read: the schema for the request has no place to put one.
import * as z from 'zod'
import { decideAccess, refusal } from '../server/access.server'
import type { Config } from '../server/board-config.server'
import { CLI_TIMEOUT_MS, spawnCli, type Outcome } from '../server/board-cli.server'
import { kickDelivery } from '../server/delivery.server'
import { jsonResponse } from '../server/json-response.server'
import { badRequest, guardWrite } from '../server/write-guard.server'
import type { BoardFailure } from '../board/board-contract'
import { jsonParsed, positiveIntegerText } from '../schema'
import {
  MAX_INPUT_LENGTH,
  MoveRequestSchema,
  SUPPORTED_MOVES_VERSION,
  parseCliMoves,
  type CliMoves,
  type CliOption,
  type MoveFailureKind,
  type MoveOption,
  type MoveOutcome,
  type MoveRequest,
  type MovesLookup,
} from './moves-contract'

/** The commands the app runs for a move. A `moves` answer naming anything else is shown as unavailable, not run. */
const RUNNABLE_COMMANDS: readonly string[] = ['note', 'release', 'cancel', 'done', 'archive']

/** A `note` also tries to reach the lead's thread before it returns, so a write may take longer than a read. */
export const WRITE_TIMEOUT_MS = 45_000

export type MovesDeps = { config: Pick<Config, 'cli' | 'boardFile' | 'node' | 'port' | 'tailnet'>; token: string }

// ---- reading what a card can do

const withFailure = (failure: BoardFailure): Outcome<never> => ({ ok: false, failure })

/** Ask the board what moves a task has, signed as `by`. The answer is the board's own, parsed before it is used. */
export async function readMoves(config: MovesDeps['config'], id: number, by: string): Promise<Outcome<CliMoves>> {
  const spawned = await spawnCli(config, ['moves', String(id), '--by', by], CLI_TIMEOUT_MS)
  if (spawned.failure) return withFailure(spawned.failure)
  const parsed = parseCliMoves.safeParse(spawned.stdout)
  if (parsed.success) return { ok: true, value: parsed.data }
  const probe = jsonParsed(z.object({ version: z.number() })).safeParse(spawned.stdout)
  if (probe.success && probe.data.version !== SUPPORTED_MOVES_VERSION) {
    return withFailure({
      kind: 'version',
      message: `the board CLI answers moves version ${probe.data.version}; this app reads version ${SUPPORTED_MOVES_VERSION}`,
    })
  }
  return withFailure({
    kind: 'output',
    message: `the board CLI printed moves this app cannot read: ${z.prettifyError(parsed.error)}`,
  })
}

const isRunnable = (option: Extract<CliOption, { command: string }>) =>
  RUNNABLE_COMMANDS.includes(option.command) && option.args[0] === option.command

function optionFor(option: CliOption): MoveOption {
  switch (option.state) {
    case 'here':
      return { state: 'here' }
    case 'refused':
      return { state: 'refused', reason: option.reason }
    case 'legal':
      return isRunnable(option)
        ? {
            state: 'legal',
            command: option.command,
            fields: option.inputs.map(({ name, required, prefill }) => ({ name, required, prefill })),
            notifies: option.notifies,
          }
        : { state: 'refused', reason: `This app does not run "${option.command}" from the board yet.` }
  }
}

/** What the browser may know about a task's moves: no command, no arguments. */
export function lookupOf(moves: CliMoves): MovesLookup {
  const { id, status, archived, revision, targets } = moves
  return {
    id,
    status,
    archived,
    revision,
    targets: {
      open: optionFor(targets.open),
      claimed: optionFor(targets.claimed),
      done: optionFor(targets.done),
      cancelled: optionFor(targets.cancelled),
      clear: optionFor(targets.clear),
    },
  }
}

// ---- running a move

type Built = { ok: true; args: string[] } | { ok: false; message: string }

const label = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** A control character other than a line break or a tab. The CLI would pass it on into the journal and the lead's thread. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true
  }
  return false
}

/**
 * The CLI argument array for a legal move and the text the owner typed. Words that belong right after the command
 * and the task id (the note text) go there; a flagged input becomes `--flag value`, and only when it has a value.
 * Every given name must be one the move asked for.
 */
export function buildMoveArgs(option: Extract<CliOption, { state: 'legal' }>, given: Record<string, string>): Built {
  const known = new Set(option.inputs.map((input) => input.name))
  const stray = Object.keys(given).find((name) => !known.has(name))
  if (stray !== undefined) return { ok: false, message: `This move does not take "${stray}".` }

  const positional: string[] = []
  const flagged: string[] = []
  for (const input of option.inputs) {
    const value = (given[input.name] ?? '').trim()
    if (value === '') {
      if (input.required) return { ok: false, message: `${label(input.name)} is required.` }
      continue
    }
    if (value.length > MAX_INPUT_LENGTH) {
      return { ok: false, message: `${label(input.name)} is longer than ${MAX_INPUT_LENGTH} characters.` }
    }
    if (hasControlCharacter(value)) {
      return { ok: false, message: `${label(input.name)} has a character the board cannot keep.` }
    }
    if (input.flag === null) {
      // The CLI reads a word that starts with two dashes as a flag, wherever it stands.
      if (value.startsWith('--')) return { ok: false, message: `${label(input.name)} cannot start with two dashes.` }
      positional.push(value)
    } else {
      flagged.push(input.flag, value)
    }
  }
  const firstFlag = option.args.findIndex((arg) => arg.startsWith('--'))
  const split = firstFlag === -1 ? option.args.length : firstFlag
  return { ok: true, args: [...option.args.slice(0, split), ...positional, ...option.args.slice(split), ...flagged] }
}

const failed = (kind: MoveFailureKind, message: string): MoveOutcome => ({ ok: false, kind, message })

/**
 * Do one move. The board is asked again now, so the command comes from what is true at this moment, and the move
 * only runs on the card the owner looked at: a changed task is refused here, a changed precondition by the CLI.
 */
export async function runMove(
  config: MovesDeps['config'],
  actor: string,
  id: number,
  request: MoveRequest,
): Promise<MoveOutcome> {
  const looked = await readMoves(config, id, actor)
  if (!looked.ok) {
    return failed(looked.failure.kind === 'refused' ? 'refused' : 'unavailable', looked.failure.message)
  }
  if (looked.value.revision !== request.revision) {
    return failed('stale', `Task ${id} changed since you looked at it. The board is showing it again.`)
  }
  const option = looked.value.targets[request.target]
  if (option.state === 'here') return failed('refused', `Task ${id} is already there.`)
  if (option.state === 'refused') return failed('refused', option.reason)
  if (!isRunnable(option)) return failed('refused', `This app does not run "${option.command}" from the board yet.`)
  const built = buildMoveArgs(option, request.inputs ?? {})
  if (!built.ok) return failed('invalid', built.message)

  const spawned = await spawnCli(config, built.args, WRITE_TIMEOUT_MS)
  if (spawned.failure) {
    return failed(spawned.failure.kind === 'refused' ? 'refused' : 'unavailable', spawned.failure.message)
  }
  // A release or a cancel settles replies that were waiting on the task, and a note may have queued a message for the
  // lead: ask the board to deliver now. Never awaited, so the owner's answer does not wait for a thread. Clearing a
  // finished task queues nothing, and the board does not deliver for a task that has left it.
  if (option.command !== 'archive') kickDelivery(config, id)
  return { ok: true, lands: option.lands }
}

// ---- the HTTP edge

const STATUS_OF: Record<MoveFailureKind, number> = {
  refused: 409,
  stale: 409,
  invalid: 400,
  forbidden: 403,
  unavailable: 502,
}

const IdParam = positiveIntegerText

/** `GET /api/moves/<id>`: what the card can do now. Reads need access only. */
export async function handleLookup(request: Request, rawId: string, deps: MovesDeps): Promise<Response> {
  const access = decideAccess({ headers: request.headers, port: deps.config.port, tailnet: deps.config.tailnet })
  if (!access.ok) return refusal(access)
  const id = IdParam.safeParse(rawId)
  if (!id.success) {
    return jsonResponse({ ok: false, failure: { kind: 'refused', message: 'That is not a task id.' } }, 400)
  }
  const looked = await readMoves(deps.config, id.data, access.actor)
  return looked.ok
    ? jsonResponse({ ok: true, moves: lookupOf(looked.value) })
    : jsonResponse({ ok: false, failure: looked.failure }, looked.failure.kind === 'refused' ? 409 : 502)
}

/**
 * `POST /api/moves/<id>`: do the move. The app's one write guard (access, the process token, an allowed Origin, a
 * small JSON body) comes first; a request it turns away answers in the board's failure envelope, and a move the
 * board turns away answers as a move outcome.
 */
export function handleMove(request: Request, rawId: string, deps: MovesDeps): Promise<Response> {
  return guardWrite(request, deps, async ({ actor, body }) => {
    const id = IdParam.safeParse(rawId)
    if (!id.success) return badRequest('That is not a task id.')
    const parsed = MoveRequestSchema.safeParse(body)
    if (!parsed.success) return badRequest(z.prettifyError(parsed.error))
    const outcome = await runMove(deps.config, actor, id.data, parsed.data)
    return jsonResponse(outcome, outcome.ok ? 200 : STATUS_OF[outcome.kind])
  })
}
