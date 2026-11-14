import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI, seedBoard } from '../../tests/temp-board'
import view from '../../tests/fixtures/view.json'
import { fixtureView } from '../../tests/fixtures/view'
import { SUPPORTED_VIEW_VERSION } from '../board/board-contract'
import { MAX_CLOSED_LIMIT, parseBoardQuery, runBoardView, viewArgs } from './board-cli.server'

const scratch = mkdtempSync(join(tmpdir(), 'board-cli-'))
let counter = 0

/** A stand-in for the board CLI: a script that runs `body` with `args` (argv) in scope. */
function fakeCli(body: string) {
  const path = join(scratch, `cli-${counter++}.mjs`)
  writeFileSync(path, body)
  return { cli: path, boardFile: join(scratch, 'tasks.json'), node: process.execPath }
}

const printing = (text: string) => fakeCli(`process.stdout.write(${JSON.stringify(text)})`)

describe('parseBoardQuery', () => {
  const parse = (query: string) => parseBoardQuery(new URLSearchParams(query))

  it('accepts the filters and a closed page', () => {
    expect(parse('role=ux-worker&tag=board&owner=worker-ux&closedLimit=50&closedBefore=1794315645549:13')).toEqual({
      ok: true,
      value: {
        role: 'ux-worker',
        tag: 'board',
        owner: 'worker-ux',
        closedLimit: 50,
        closedBefore: '1794315645549:13',
      },
    })
  })

  it('accepts an empty query and the cursor of a task with no close time', () => {
    expect(parse('')).toEqual({ ok: true, value: {} })
    expect(parse('closedBefore=none:7').ok).toBe(true)
  })

  it.each([
    ['an empty filter', 'role='],
    ['a closed limit of zero', 'closedLimit=0'],
    ['a closed limit past the cap', `closedLimit=${MAX_CLOSED_LIMIT + 1}`],
    ['a closed limit that is not a number', 'closedLimit=many'],
    ['a malformed cursor', 'closedBefore=abc'],
    ['a cursor that tries to carry a flag', 'closedBefore=1:2 --owner x'],
  ])('refuses %s', (_name, query) => {
    const parsed = parse(query)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.failure.kind).toBe('refused')
  })

  it('ignores a parameter it does not know instead of passing it on', () => {
    const parsed = parse('role=qa-worker&--help=1')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(viewArgs(parsed.value)).toEqual(['view', '--role', 'qa-worker'])
  })
})

describe('viewArgs', () => {
  it('passes only the flags the query sets, in a fixed order', () => {
    expect(viewArgs({})).toEqual(['view'])
    expect(viewArgs({ closedBefore: '9:1', owner: 'o', closedLimit: 5, tag: 't', role: 'r' })).toEqual([
      'view',
      '--role',
      'r',
      '--tag',
      't',
      '--owner',
      'o',
      '--closed-limit',
      '5',
      '--closed-before',
      '9:1',
    ])
  })

  it('keeps a value that looks like a flag as one argument', () => {
    expect(viewArgs({ role: '--force; rm -rf /' })).toEqual(['view', '--role', '--force; rm -rf /'])
  })
})

describe('runBoardView', () => {
  it('parses what the CLI prints into the view', async () => {
    const outcome = await runBoardView(printing(JSON.stringify(view)), {})
    expect(outcome).toEqual({ ok: true, value: fixtureView })
  })

  it('runs the CLI with the board file in its environment and the query as its arguments', async () => {
    const out = join(scratch, `argv-${counter}.json`)
    const config = fakeCli(`
      import { writeFileSync } from 'node:fs'
      import view from ${JSON.stringify(join(import.meta.dirname, '../../tests/fixtures/view.json'))} with { type: 'json' }
      writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), file: process.env.TEAM_TASKS_FILE }))
      process.stdout.write(JSON.stringify(view))
    `)
    const outcome = await runBoardView(config, { role: 'ux-worker', closedLimit: 20 })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      argv: ['view', '--role', 'ux-worker', '--closed-limit', '20'],
      file: config.boardFile,
    })
  })

  it("passes on the CLI's own words when it refuses", async () => {
    const outcome = await runBoardView(
      fakeCli(`process.stderr.write('team-tasks: unknown flag --nope\\nusage: ...\\n'); process.exit(2)`),
      {},
    )
    expect(outcome).toEqual({ ok: false, failure: { kind: 'refused', message: 'unknown flag --nope' } })
  })

  it('reports a CLI that exits without a word', async () => {
    const outcome = await runBoardView(fakeCli('process.exit(3)'), {})
    expect(outcome).toEqual({ ok: false, failure: { kind: 'refused', message: 'the board CLI exited 3' } })
  })

  it('reports output that is not JSON', async () => {
    const outcome = await runBoardView(printing('this is not json'), {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('output')
  })

  it('reports JSON of the wrong shape and names what is wrong', async () => {
    const outcome = await runBoardView(printing(JSON.stringify({ ...view, tasks: 'nope' })), {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('output')
      expect(outcome.failure.message).toContain('tasks')
    }
  })

  it('says so when the CLI answers another view version', async () => {
    const outcome = await runBoardView(printing(JSON.stringify({ ...view, version: SUPPORTED_VIEW_VERSION + 1 })), {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('version')
      expect(outcome.failure.message).toContain(String(SUPPORTED_VIEW_VERSION + 1))
    }
  })

  it('stops a CLI that takes too long', async () => {
    const outcome = await runBoardView(fakeCli('setInterval(() => {}, 1000)'), {}, 300)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('timeout')
  })

  it('reports a Node binary that cannot be run', async () => {
    const config = { ...printing('{}'), node: join(scratch, 'no-such-node') }
    const outcome = await runBoardView(config, {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('spawn')
  })

  it('runs one CLI for callers that ask for the same view at once', async () => {
    const counts = join(scratch, `runs-${counter}`)
    mkdirSync(counts)
    const config = fakeCli(`
      import { writeFileSync } from 'node:fs'
      import view from ${JSON.stringify(join(import.meta.dirname, '../../tests/fixtures/view.json'))} with { type: 'json' }
      writeFileSync(${JSON.stringify(counts)} + '/' + process.pid, '')
      await new Promise((resolve) => setTimeout(resolve, 150))
      process.stdout.write(JSON.stringify(view))
    `)
    const [first, second, other] = await Promise.all([
      runBoardView(config, {}),
      runBoardView(config, {}),
      runBoardView(config, { role: 'qa-worker' }),
    ])
    expect(first.ok && second.ok && other.ok).toBe(true)
    expect(first).toBe(second)
    expect(readdirSync(counts)).toHaveLength(2)
  })

  it('reads a real board with the real CLI (the contract canary)', async () => {
    const seed = seedBoard(join(scratch, 'real', 'tasks.json'), { closed: 3 })
    const outcome = await runBoardView({ cli: CLI, boardFile: seed.file, node: process.execPath }, { closedLimit: 2 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value.counts.open).toBe(seed.open.length)
      expect(outcome.value.counts.claimed).toBe(seed.claimed.length)
      expect(outcome.value.closed.tasks).toHaveLength(2)
    }
  })
})
