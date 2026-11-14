import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TOKEN_HEADER } from '../server/access.server'
import { deliveryIdle } from '../server/delivery.server'
import { methodNotAllowed } from '../server/write-guard.server'
import { CLI, addTask, claimTask, cli, cliJson } from '../../tests/temp-board'
import { buildMoveArgs, handleLookup, handleMove, lookupOf, readMoves, runMove, type MovesDeps } from './moves.server'
import { parseCliMoves, type CliMoves } from './moves-contract'

const scratch = mkdtempSync(join(tmpdir(), 'board-moves-'))
const sendLog = join(scratch, 't3-sends.log')
let counter = 0
const PORT = 4788
const TOKEN = 'm'.repeat(64)
const saved = { ...process.env }

beforeAll(() => {
  // A note to the lead may try to deliver; the fake `t3` is the only binary it can reach.
  process.env.TEAM_BOARD_T3_BIN = resolve(import.meta.dirname, '../../../../scripts/team-board-delivery.fake-t3.mjs')
  process.env.TEAM_BOARD_FAKE_LOG = sendLog
})

beforeEach(() => {
  rmSync(sendLog, { force: true })
  delete process.env.TEAM_BOARD_FAKE_SLEEP_MS
})

afterAll(async () => {
  await deliveryIdle()
  process.env = saved
  rmSync(scratch, { recursive: true, force: true })
})

/** What the fake `t3` was asked to send since the test began. */
const sends = () =>
  existsSync(sendLog)
    ? readFileSync(sendLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
    : []

/** A fresh scratch board: one open ux task, one claimed qa task, one cancelled task. */
function board() {
  const dir = join(scratch, `board-${counter++}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'tasks.json')
  const open = addTask(file, 'ux-worker', 'Tune the tab strip')
  const claimed = addTask(file, 'qa-worker', 'Check the filters')
  claimTask(file, 'qa-worker', 'worker-qa', claimed)
  const cancelled = addTask(file, 'perf-worker', 'Profile the card list')
  cli(file, ['cancel', String(cancelled)])
  const deps: MovesDeps = {
    config: { cli: CLI, boardFile: file, node: process.execPath, port: PORT, tailnet: null },
    token: TOKEN,
  }
  return { file, open, claimed, cancelled, deps }
}

const statusOf = (file: string, id: number) =>
  cliJson<{ id: number; status: string }>(file, ['show', String(id)]).status

async function revisionOf(deps: MovesDeps, id: number) {
  const moves = await readMoves(deps.config, id, 'owner')
  if (!moves.ok) throw new Error(moves.failure.message)
  return moves.value.revision
}

describe('lookupOf', () => {
  it('tells the browser what each target does without a command line', async () => {
    const { deps, claimed } = board()
    const moves = await readMoves(deps.config, claimed, 'owner')
    if (!moves.ok) throw new Error(moves.failure.message)
    const lookup = lookupOf(moves.value)
    expect(lookup.targets.claimed).toEqual({ state: 'here' })
    expect(lookup.targets.cancelled).toMatchObject({
      state: 'legal',
      command: 'cancel',
      fields: [{ name: 'reason', required: true, prefill: null }],
    })
    expect(lookup.targets.done).toMatchObject({ state: 'refused' })
    const sent = JSON.stringify(lookup)
    expect(sent).not.toContain('--by')
    expect(sent).not.toContain('"args"')
  })

  it('shows a command this app does not run as unavailable, and never offers it', () => {
    const unknown = parseCliMoves(
      JSON.stringify({
        version: 1,
        id: 4,
        by: 'owner',
        status: 'open',
        archived: false,
        revision: 'r',
        targets: {
          open: { state: 'here' },
          claimed: {
            state: 'legal',
            command: 'claim',
            args: ['claim', 'lead', 'owner', '--id', '4'],
            inputs: [],
            lands: 'claimed',
            notifies: [],
          },
          done: { state: 'refused', command: 'done', args: [], inputs: [], reason: 'nope' },
          cancelled: { state: 'refused', command: 'cancel', args: [], inputs: [], reason: 'nope' },
          clear: { state: 'refused', command: 'cancel', args: [], inputs: [], reason: 'nope' },
        },
      }),
    ) as CliMoves
    expect(lookupOf(unknown).targets.claimed).toEqual({
      state: 'refused',
      reason: 'This app does not run "claim" from the board yet.',
    })
  })
})

describe('buildMoveArgs', () => {
  const noteMove = {
    state: 'legal' as const,
    command: 'note',
    args: ['note', '7', '--by', 'owner', '--expected', 'rev'],
    inputs: [{ name: 'text', flag: null, required: true, prefill: 'Please start task 7' }],
    lands: 'open',
    notifies: ['lead'],
  }
  const cancelMove = {
    state: 'legal' as const,
    command: 'cancel',
    args: ['cancel', '7', '--by', 'owner'],
    inputs: [{ name: 'reason', flag: '--reason', required: true, prefill: null }],
    lands: 'cancelled',
    notifies: [],
  }
  const releaseMove = { ...cancelMove, command: 'release', args: ['release', '7', '--by', 'owner'] }
  const releaseOptional = {
    ...releaseMove,
    inputs: [{ name: 'reason', flag: '--reason', required: false, prefill: null }],
  }

  it('puts the note text right after the task id and keeps the flags after it', () => {
    expect(buildMoveArgs(noteMove, { text: '  Please start task 7  ' })).toEqual({
      ok: true,
      args: ['note', '7', 'Please start task 7', '--by', 'owner', '--expected', 'rev'],
    })
  })

  it('appends a flagged input as a flag and a value', () => {
    expect(buildMoveArgs(cancelMove, { reason: 'Dead end' })).toEqual({
      ok: true,
      args: ['cancel', '7', '--by', 'owner', '--reason', 'Dead end'],
    })
  })

  it('leaves out an optional input that is empty', () => {
    expect(buildMoveArgs(releaseOptional, {})).toEqual({ ok: true, args: ['release', '7', '--by', 'owner'] })
    expect(buildMoveArgs(releaseOptional, { reason: '   ' })).toEqual({
      ok: true,
      args: ['release', '7', '--by', 'owner'],
    })
  })

  it.each([
    ['a missing required input', cancelMove, {}],
    ['a blank required input', cancelMove, { reason: '  ' }],
    ['a field the move did not ask for', cancelMove, { reason: 'x', command: 'archive' }],
    ['text that starts like a flag', noteMove, { text: '--by someone' }],
    ['a control character', cancelMove, { reason: 'a\u0000b' }],
    ['text past the limit', cancelMove, { reason: 'x'.repeat(2001) }],
  ])('refuses %s', (_name, move, given) => {
    expect(buildMoveArgs(move, given).ok).toBe(false)
  })

  it('keeps a line break and any other word of the text whole, as one argument', () => {
    const built = buildMoveArgs(cancelMove, { reason: 'Line one\nthen --force and $(rm -rf)' })
    expect(built).toEqual({
      ok: true,
      args: ['cancel', '7', '--by', 'owner', '--reason', 'Line one\nthen --force and $(rm -rf)'],
    })
  })
})

describe('runMove', () => {
  it('cancels a claimed task with the reason the owner typed', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const outcome = await runMove(deps.config, 'owner', claimed, {
      target: 'cancelled',
      revision,
      inputs: { reason: 'Dead end' },
    })
    expect(outcome).toEqual({ ok: true, lands: 'cancelled' })
    expect(statusOf(file, claimed)).toBe('cancelled')
    expect(readFileSync(file, 'utf8')).toContain('Dead end')
  })

  it('releases a claimed task back to open', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const outcome = await runMove(deps.config, 'owner', claimed, { target: 'open', revision, inputs: {} })
    expect(outcome).toEqual({ ok: true, lands: 'open' })
    expect(statusOf(file, claimed)).toBe('open')
  })

  it('sends the lead a note to start an open task and leaves the task open', async () => {
    const { deps, file, open } = board()
    const revision = await revisionOf(deps, open)
    const outcome = await runMove(deps.config, 'owner', open, {
      target: 'claimed',
      revision,
      inputs: { text: 'Please start task now' },
    })
    expect(outcome.ok).toBe(true)
    expect(statusOf(file, open)).toBe('open')
    expect(readFileSync(file, 'utf8')).toContain('Please start task now')
  })

  it('archives a cancelled task for Clear', async () => {
    const { deps, file, cancelled } = board()
    const revision = await revisionOf(deps, cancelled)
    const outcome = await runMove(deps.config, 'owner', cancelled, { target: 'clear', revision, inputs: {} })
    expect(outcome).toEqual({ ok: true, lands: 'archived' })
    expect(readFileSync(file, 'utf8')).toContain('"archived": true')
  })

  it("refuses with the board's own words and writes nothing", async () => {
    const { deps, file, open } = board()
    const before = readFileSync(file, 'utf8')
    const revision = await revisionOf(deps, open)
    const outcome = await runMove(deps.config, 'owner', open, { target: 'done', revision, inputs: {} })
    expect(outcome).toEqual({
      ok: false,
      kind: 'refused',
      message: `task ${open} is open, not claimed; claim it first (or --force)`,
    })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses a cancelled task that is dropped on Cancelled again', async () => {
    const { deps, cancelled } = board()
    const revision = await revisionOf(deps, cancelled)
    const outcome = await runMove(deps.config, 'owner', cancelled, { target: 'cancelled', revision, inputs: {} })
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' })
  })

  it('refuses a move on a card that changed since the owner looked', async () => {
    const { deps, file, claimed } = board()
    const seen = await revisionOf(deps, claimed)
    cli(file, ['release', String(claimed), '--by', 'someone-else'])
    cli(file, ['claim', 'qa-worker', 'worker-qa-2', '--id', String(claimed)])
    const outcome = await runMove(deps.config, 'owner', claimed, {
      target: 'cancelled',
      revision: seen,
      inputs: { reason: 'x' },
    })
    expect(outcome).toMatchObject({ ok: false, kind: 'stale' })
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('refuses a missing required input before it runs anything', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const outcome = await runMove(deps.config, 'owner', claimed, { target: 'cancelled', revision, inputs: {} })
    expect(outcome).toEqual({ ok: false, kind: 'invalid', message: 'Reason is required.' })
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('says a task that does not exist does not exist', async () => {
    const { deps } = board()
    const outcome = await runMove(deps.config, 'owner', 999, { target: 'clear', revision: 'x', inputs: {} })
    expect(outcome).toEqual({ ok: false, kind: 'refused', message: 'task 999 does not exist' })
  })
})

describe('the write route', () => {
  const urlFor = (id: number) => `http://127.0.0.1:${PORT}/api/moves/${id}`
  const post = (deps: MovesDeps, id: number, body: unknown, headers: Record<string, string> = {}) =>
    handleMove(
      new Request(urlFor(id), {
        method: 'POST',
        headers: {
          host: `127.0.0.1:${PORT}`,
          'content-type': 'application/json',
          [TOKEN_HEADER]: TOKEN,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      String(id),
      deps,
    )

  it('does the move with the token from the page', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const response = await post(deps, claimed, { target: 'cancelled', revision, inputs: { reason: 'Over' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, lands: 'cancelled' })
    expect(statusOf(file, claimed)).toBe('cancelled')
  })

  it('refuses a write with no token', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const response = await post(
      deps,
      claimed,
      { target: 'cancelled', revision, inputs: { reason: 'x' } },
      { [TOKEN_HEADER]: '' },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      ok: false,
      failure: { kind: 'refused', message: 'missing or invalid token' },
    })
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('refuses a write with the wrong token', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const response = await post(
      deps,
      claimed,
      { target: 'cancelled', revision, inputs: { reason: 'x' } },
      { [TOKEN_HEADER]: 'w'.repeat(64) },
    )
    expect(response.status).toBe(403)
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('refuses a write from a foreign Origin', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const response = await post(
      deps,
      claimed,
      { target: 'cancelled', revision, inputs: { reason: 'x' } },
      { origin: 'https://evil.example' },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ ok: false, failure: { message: 'bad origin' } })
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('refuses a write to a foreign Host', async () => {
    const { deps, file, claimed } = board()
    const revision = await revisionOf(deps, claimed)
    const response = await post(
      deps,
      claimed,
      { target: 'cancelled', revision, inputs: { reason: 'x' } },
      { host: 'evil.example' },
    )
    expect(response.status).toBe(403)
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('refuses a body that is not a move, or not JSON', async () => {
    const { deps, claimed } = board()
    const bad = await post(deps, claimed, { target: 'rm -rf', revision: 'x' })
    expect(bad.status).toBe(400)
    const plain = await post(deps, claimed, { target: 'clear', revision: 'x' }, { 'content-type': 'text/plain' })
    expect(plain.status).toBe(400)
    const noId = await post(deps, claimed, { target: 'clear', revision: 'x' })
    expect(noId.status).toBe(409)
  })

  it('ignores a command or arguments the browser tries to add', async () => {
    const { deps, file, claimed, cancelled } = board()
    const revision = await revisionOf(deps, claimed)
    const response = await post(deps, claimed, {
      target: 'cancelled',
      revision,
      inputs: { reason: 'Because' },
      command: 'archive',
      args: ['archive', '--id', String(cancelled)],
    })
    expect(response.status).toBe(200)
    expect(readFileSync(file, 'utf8')).not.toContain('"archived": true')
    expect(statusOf(file, claimed)).toBe('cancelled')
  })

  it('refuses a task id that is not a number', async () => {
    const { deps } = board()
    const response = await handleMove(
      new Request(urlFor(1), {
        method: 'POST',
        headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN },
        body: '{}',
      }),
      '1; rm',
      deps,
    )
    expect(response.status).toBe(400)
  })

  it('reads moves for a task with the lookup route and refuses a foreign Host there too', async () => {
    const { deps, claimed } = board()
    const ok = await handleLookup(
      new Request(urlFor(claimed), { headers: { host: `127.0.0.1:${PORT}` } }),
      String(claimed),
      deps,
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, moves: { id: claimed, status: 'claimed' } })
    const foreign = await handleLookup(
      new Request(urlFor(claimed), { headers: { host: 'evil.example' } }),
      String(claimed),
      deps,
    )
    expect(foreign.status).toBe(403)
  })

  it('answers a method it does not handle with 405', async () => {
    const response = methodNotAllowed(['GET', 'POST'])
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
  })

  it('refuses a write that is not a POST before it reads a body or runs anything', async () => {
    const { deps, file, claimed } = board()
    const response = await handleMove(
      new Request(urlFor(claimed), {
        method: 'PUT',
        headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN },
        body: JSON.stringify({ target: 'cancelled', revision: 'x', inputs: { reason: 'x' } }),
      }),
      String(claimed),
      deps,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(statusOf(file, claimed)).toBe('claimed')
  })

  it('refuses a body that is too large with the guard, before it parses a move', async () => {
    const { deps, claimed } = board()
    const response = await post(deps, claimed, {
      target: 'cancelled',
      revision: 'x',
      inputs: { reason: 'y'.repeat(20_000) },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, failure: { message: 'the request is too large' } })
  })
})

describe('delivery after a move', () => {
  /** A claimed task whose worker and whose lead both have a thread, so a cancel has someone to tell. */
  function wired() {
    const made = board()
    cli(made.file, ['lead-wake', 'thread:lead', '--by', 'lead'])
    cli(made.file, ['heartbeat', String(made.claimed), '--owner', 'worker-qa', '--wake', 'thread:worker'])
    return made
  }
  const cancelOf = async (deps: MovesDeps, id: number) =>
    runMove(deps.config, 'owner', id, {
      target: 'cancelled',
      revision: await revisionOf(deps, id),
      inputs: { reason: 'Superseded by the new plan' },
    })

  it('asks the board to deliver once a move succeeds', async () => {
    const { deps, claimed } = wired()
    expect(await cancelOf(deps, claimed)).toEqual({ ok: true, lands: 'cancelled' })
    await deliveryIdle()
    expect(sends().length).toBeGreaterThan(0)
  })

  it('does not hold the answer for the delivery', async () => {
    process.env.TEAM_BOARD_FAKE_SLEEP_MS = '1500'
    const { deps, claimed } = wired()
    const started = Date.now()
    expect(await cancelOf(deps, claimed)).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeLessThan(1200)
    await deliveryIdle()
  })

  it('asks for no delivery when a finished task is cleared', async () => {
    const { deps, cancelled } = wired()
    const outcome = await runMove(deps.config, 'owner', cancelled, {
      target: 'clear',
      revision: await revisionOf(deps, cancelled),
      inputs: {},
    })
    expect(outcome).toEqual({ ok: true, lands: 'archived' })
    await deliveryIdle()
    expect(sends()).toEqual([])
  })

  it('asks for no delivery when the board refuses the move', async () => {
    const { deps, open } = wired()
    const outcome = await runMove(deps.config, 'owner', open, {
      target: 'done',
      revision: await revisionOf(deps, open),
      inputs: {},
    })
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' })
    await deliveryIdle()
    expect(sends()).toEqual([])
  })
})
