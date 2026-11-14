// The only module that runs the board CLI. It spawns `node <cli> view ...` with an argument array (no shell) and a
// bounded time, and parses the JSON with arktype before anything inward sees it. Nothing else in the app
// touches the CLI or the board file.
import { execFile } from 'node:child_process'
import { type } from 'arktype'
import { BoardViewSchema, SUPPORTED_VIEW_VERSION } from '../board/board-contract'
import type { BoardFailure, BoardView } from '../board/board-contract'
import type { Config } from './board-config.server'

/** The CLI reads 1,500 tasks in about 0.15 s; this is the room for a loaded Mac, not a target. */
export const CLI_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
export const MAX_CLOSED_LIMIT = 200

/** The filters and page the page may ask for, as they arrive in a query string. */
export const BoardQuerySchema = type({
  'role?': 'string > 0 & string <= 200',
  'tag?': 'string > 0 & string <= 200',
  'owner?': 'string > 0 & string <= 500',
  'closedLimit?': type('string.integer.parse').to(`1 <= number.integer <= ${MAX_CLOSED_LIMIT}`),
  'closedBefore?': /^(-?\d+|none):\d+$/,
})
export type BoardQuery = typeof BoardQuerySchema.infer

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: BoardFailure }

/** Read a query string into a BoardQuery, or say what is wrong with it. */
export function parseBoardQuery(params: URLSearchParams): Outcome<BoardQuery> {
  const parsed = BoardQuerySchema(Object.fromEntries(params))
  return parsed instanceof type.errors
    ? { ok: false, failure: { kind: 'refused', message: parsed.summary } }
    : { ok: true, value: parsed }
}

const ParsedView = type('string.json.parse').pipe(BoardViewSchema)
const VersionProbe = type('string.json.parse').pipe(type({ version: 'number' }))

/** `view`'s arguments for a query, in a fixed order. A flag the query leaves out is not passed. */
export function viewArgs(query: BoardQuery): string[] {
  const flags: [string, string | number | undefined][] = [
    ['--role', query.role],
    ['--tag', query.tag],
    ['--owner', query.owner],
    ['--closed-limit', query.closedLimit],
    ['--closed-before', query.closedBefore],
  ]
  return ['view', ...flags.flatMap(([flag, value]) => (value === undefined ? [] : [flag, String(value)]))]
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
/** The CLI's own words for a refusal: its first stderr line without the `team-tasks:` prefix. */
export const refusalOf = (stderr: string) =>
  firstLine(stderr)
    .replace(/^team-tasks:\s*/, '')
    .slice(0, 300)

export type Spawned = { stdout: string; failure: null } | { stdout: null; failure: BoardFailure }

/** Run one board CLI command. Every caller, read or write, goes through here: argument array, no shell, bounded time. */
export function spawnCli(config: Pick<Config, 'cli' | 'boardFile' | 'node'>, args: string[], timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs)
  return new Promise<Spawned>((resolve) => {
    execFile(
      config.node,
      [config.cli, ...args],
      {
        env: { ...process.env, TEAM_TASKS_FILE: config.boardFile },
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, failure: null })
        if (signal.aborted) {
          return resolve({
            stdout: null,
            failure: { kind: 'timeout', message: `the board CLI took longer than ${timeoutMs / 1000} seconds` },
          })
        }
        if (typeof (error as { code?: unknown }).code === 'number') {
          return resolve({
            stdout: null,
            failure: { kind: 'refused', message: refusalOf(stderr) || `the board CLI exited ${error.code}` },
          })
        }
        resolve({ stdout: null, failure: { kind: 'spawn', message: `cannot run the board CLI: ${error.message}` } })
      },
    )
  })
}

const inflight = new Map<string, Promise<Outcome<BoardView>>>()

async function readView(config: Pick<Config, 'cli' | 'boardFile' | 'node'>, query: BoardQuery, timeoutMs: number) {
  const spawned = await spawnCli(config, viewArgs(query), timeoutMs)
  if (spawned.failure) return { ok: false, failure: spawned.failure } satisfies Outcome<BoardView>
  const parsed = ParsedView(spawned.stdout)
  if (!(parsed instanceof type.errors)) return { ok: true, value: parsed } satisfies Outcome<BoardView>
  const probe = VersionProbe(spawned.stdout)
  if (!(probe instanceof type.errors) && probe.version !== SUPPORTED_VIEW_VERSION) {
    return {
      ok: false,
      failure: {
        kind: 'version',
        message: `the board CLI answers view version ${probe.version}; this app reads version ${SUPPORTED_VIEW_VERSION}`,
      },
    } satisfies Outcome<BoardView>
  }
  return {
    ok: false,
    failure: { kind: 'output', message: `the board CLI printed a view this app cannot read: ${parsed.summary}` },
  } satisfies Outcome<BoardView>
}

/**
 * The board as the page renders it. Callers asking for the same view while one run is in flight share that run,
 * so a burst of browsers costs the Mac one CLI process, not one each.
 */
export function runBoardView(
  config: Pick<Config, 'cli' | 'boardFile' | 'node'>,
  query: BoardQuery,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<Outcome<BoardView>> {
  const key = JSON.stringify([config.cli, config.boardFile, viewArgs(query)])
  const running = inflight.get(key)
  if (running) return running
  const started = readView(config, query, timeoutMs).finally(() => inflight.delete(key))
  inflight.set(key, started)
  return started
}
