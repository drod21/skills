import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runHealth } from './team-tasks.lib.mjs'

const CLI = join(import.meta.dirname, 'team-tasks.mjs')
const FAKE = join(import.meta.dirname, 'team-tasks-runs.fake-t3.mjs')

// ---------------------------------------------------------------- lib cases (injected probes)

const NOW = new Date('2026-11-10T12:00:00.000Z')
const CLAIMED_AT = '2026-11-10T11:00:00.000Z'
const ENDED_AT = '2026-11-10T11:30:00.000Z'

type Probe = { state: string; activeRunId: string | null; updatedAt?: string } | { missing: true } | { error: string }
type Finding = { level: string; code: string; message: string; id?: number }

const endedProbe = (state = 'completed'): Probe => ({ state, activeRunId: null, updatedAt: ENDED_AT })
const runningProbe: Probe = { state: 'running', activeRunId: 'run:thread:w:ordinal:3' }

function claimed(
  id: number,
  { wake, run, wakeAt = CLAIMED_AT }: { wake?: string; run?: { kind: string; ref: string }; wakeAt?: string } = {},
) {
  return {
    id,
    role: 'qa-worker',
    title: `task ${id}`,
    status: 'claimed',
    owner: `owner-${id}`,
    after: [],
    route: null,
    accept: 'done',
    claimedAt: CLAIMED_AT,
    ...(run ? { run: { ...run, at: CLAIMED_AT } } : {}),
    ...(wake ? { wake: { threadId: wake, at: wakeAt } } : {}),
  }
}

const boardOf = (...tasks: object[]) => ({ version: 1, tasks })
const health = (board: object, probes: Record<string, Probe>): Finding[] => runHealth(board, probes, NOW)
const forTask = (findings: Finding[], id: number) => findings.filter((finding) => finding.id === id)
const byCode = (findings: Finding[], code: string) => findings.filter((finding) => finding.code === code)

describe('runHealth', () => {
  it('F-1: warns run-ended for a claim whose current wake thread is not running', () => {
    const findings = health(boardOf(claimed(5, { wake: 'thread:w5' })), { 'thread:w5': endedProbe() })
    const ended = byCode(findings, 'run-ended')
    expect(ended).toHaveLength(1)
    expect(ended[0].level).toBe('warn')
    expect(ended[0].id).toBe(5)
    expect(ended[0].message).toContain('completed')
    expect(ended[0].message).toContain(ENDED_AT)
  })

  it('F-1b: quotes any non-running state as given', () => {
    const findings = health(boardOf(claimed(5, { wake: 'thread:w5' })), { 'thread:w5': endedProbe('interrupted') })
    const ended = byCode(findings, 'run-ended')
    expect(ended).toHaveLength(1)
    expect(ended[0].id).toBe(5)
    expect(ended[0].message).toContain('interrupted')
  })

  it('F-1c: a thread is running only when activeRunId is a non-empty string', () => {
    const board = boardOf(claimed(5, { wake: 'thread:w5' }), claimed(6, { wake: 'thread:w6' }))
    const findings = health(board, {
      'thread:w5': { state: 'running', activeRunId: null, updatedAt: ENDED_AT },
      'thread:w6': { state: 'completed', activeRunId: 'run:thread:w6:ordinal:1' },
    })
    expect(byCode(findings, 'run-ended').map((finding) => finding.id)).toEqual([5])
    expect(forTask(findings, 6)).toEqual([])
  })

  it('F-2: reports nothing for a running thread', () => {
    const findings = health(boardOf(claimed(5, { wake: 'thread:w5' })), { 'thread:w5': runningProbe })
    expect(forTask(findings, 5)).toEqual([])
    expect(byCode(findings, 'run-ended')).toEqual([])
    expect(byCode(findings, 'run-missing')).toEqual([])
  })

  it('F-3: warns run-missing when t3 says the thread does not exist', () => {
    const findings = health(boardOf(claimed(5, { wake: 'thread:w5' })), { 'thread:w5': { missing: true } })
    const missing = byCode(findings, 'run-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0].level).toBe('warn')
    expect(missing[0].id).toBe(5)
    expect(byCode(findings, 'run-ended')).toEqual([])
  })

  it('F-4: lists every thread that could not be checked in one runs-unchecked info finding', () => {
    const board = boardOf(claimed(5, { wake: 'thread:w5' }), claimed(6, { wake: 'thread:w6' }))
    const findings = health(board, { 'thread:w5': { error: 'timeout' }, 'thread:w6': { error: 'timeout' } })
    const unchecked = byCode(findings, 'runs-unchecked')
    expect(unchecked).toHaveLength(1)
    expect(unchecked[0].level).toBe('info')
    expect(unchecked[0].message).toContain('5')
    expect(unchecked[0].message).toContain('6')
    expect(byCode(findings, 'run-ended')).toEqual([])
    expect(byCode(findings, 'run-missing')).toEqual([])
  })

  it('F-5: lists claims with a t3_task run but no current wake in one run-unlinked info finding', () => {
    const board = boardOf(
      claimed(7, { run: { kind: 't3_task', ref: 'build-7' } }),
      claimed(9, { run: { kind: 't3_task', ref: 'build-9' } }),
      claimed(11, { run: { kind: 'session', ref: 'lead-11' } }),
      claimed(12, { run: { kind: 't3_task', ref: 'build-12' }, wake: 'thread:w12' }),
    )
    const findings = health(board, { 'thread:w12': runningProbe })
    const unlinked = byCode(findings, 'run-unlinked')
    expect(unlinked).toHaveLength(1)
    expect(unlinked[0].level).toBe('info')
    expect(unlinked[0].message).toContain('7')
    expect(unlinked[0].message).toContain('9')
    expect(unlinked[0].message).not.toContain('11')
    expect(unlinked[0].message).not.toContain('12')
  })

  it('F-6: a stale wake (at differs from claimedAt) is not probed and does not count as linked', () => {
    const board = boardOf(
      claimed(8, { wake: 'thread:old', wakeAt: '2026-11-09T09:00:00.000Z' }),
      claimed(13, {
        run: { kind: 't3_task', ref: 'build-13' },
        wake: 'thread:old13',
        wakeAt: '2026-11-09T09:00:00.000Z',
      }),
    )
    // The probe for the stale thread says ended; a stale wake must not be looked at, so no finding may name task 8.
    const findings = health(board, { 'thread:old': endedProbe(), 'thread:old13': endedProbe() })
    expect(forTask(findings, 8)).toEqual([])
    expect(byCode(findings, 'run-ended')).toEqual([])
    expect(byCode(findings, 'run-missing')).toEqual([])
    expect(byCode(findings, 'runs-unchecked')).toEqual([])
    // Task 8 has no t3 run, so it is not unlinked; task 13 has one and no current wake, so it is.
    const unlinked = byCode(findings, 'run-unlinked')
    expect(unlinked).toHaveLength(1)
    expect(unlinked[0].message).toContain('13')
  })

  it('F-7: open and done tasks with a leftover wake are ignored', () => {
    const open = { ...claimed(20, { wake: 'thread:w20' }), status: 'open', owner: null }
    const done = { ...claimed(21, { wake: 'thread:w21' }), status: 'done' }
    const findings = health(boardOf(open, done), { 'thread:w20': endedProbe(), 'thread:w21': { missing: true } })
    expect(findings).toEqual([])
  })
})

// ---------------------------------------------------------------- CLI cases (fake t3)

let dir: string
let board: string
let log: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-runs-'))
  board = join(dir, 'tasks.json')
  log = join(dir, 't3.log')
  chmodSync(FAKE, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

type FakeEntry = { stdout?: string; stderr?: string; exit?: number; sleepMs?: number }

function cli(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TEAM_TASKS_FILE: board, TEAM_BOARD_T3_BIN: FAKE, TEAM_BOARD_FAKE_LOG: log, ...env },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
  }
}

const fakeMap = (map: Record<string, FakeEntry>) => ({ TEAM_BOARD_FAKE_MAP: JSON.stringify(map) })

const endedJson = (threadId: string) =>
  JSON.stringify({
    thread: { threadId, status: 'completed', activeRunId: null, updatedAt: ENDED_AT },
    messages: [],
  })
const runningJson = (threadId: string) =>
  JSON.stringify({
    thread: { threadId, status: 'running', activeRunId: `run:thread:${threadId}:ordinal:2`, updatedAt: ENDED_AT },
    messages: [],
  })

function claimWithWake(wake: string) {
  const added = cli({}, 'add', 'qa-worker', `task for ${wake}`, '--accept', 'the work is done')
  expect(added.status).toBe(0)
  const id = added.json.id as number
  expect(cli({}, 'claim', 'qa-worker', 'worker', '--id', String(id), '--wake', wake).status).toBe(0)
  return id
}

function t3Calls() {
  if (!existsSync(log)) return [] as string[][]
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const { argv } = JSON.parse(line) as { argv: string[] }
      return argv.slice(argv.indexOf('thread'))
    })
}

describe('doctor --runs and stale --runs', () => {
  it('F-8: doctor --runs warns run-ended, stays ok, and asks t3 exactly once per thread', () => {
    const id = claimWithWake('thread:w5')
    const result = cli(fakeMap({ 'thread:w5': { stdout: endedJson('thread:w5') } }), 'doctor', '--runs')
    expect(result.status).toBe(0)
    expect(result.json.ok).toBe(true)
    const ended = result.json.findings.filter((finding: Finding) => finding.code === 'run-ended')
    expect(ended).toHaveLength(1)
    expect(ended[0].level).toBe('warn')
    expect(ended[0].id).toBe(id)
    expect(ended[0].message).toContain('completed')
    expect(t3Calls()).toEqual([['thread', 'show', 'thread:w5', '--json', '--messages', '0']])
  })

  it('F-8b: doctor --runs warns run-missing for an unknown thread and stays ok', () => {
    const id = claimWithWake('thread:gone')
    const result = cli(fakeMap({}), 'doctor', '--runs')
    expect(result.status).toBe(0)
    expect(result.json.ok).toBe(true)
    const missing = result.json.findings.filter((finding: Finding) => finding.code === 'run-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0].level).toBe('warn')
    expect(missing[0].id).toBe(id)
  })

  it('F-8c: doctor --runs says nothing about a running thread', () => {
    claimWithWake('thread:live')
    const result = cli(fakeMap({ 'thread:live': { stdout: runningJson('thread:live') } }), 'doctor', '--runs')
    expect(result.status).toBe(0)
    expect(result.json.findings.filter((finding: Finding) => finding.code.startsWith('run-'))).toEqual([])
    expect(t3Calls()).toHaveLength(1)
  })

  it('F-8d: unparsable stdout and non-zero exits with other text are unchecked, not missing', () => {
    claimWithWake('thread:garbled')
    claimWithWake('thread:boom')
    const result = cli(
      fakeMap({
        'thread:garbled': { stdout: 'not json' },
        'thread:boom': { exit: 2, stderr: 'internal error' },
      }),
      'doctor',
      '--runs',
    )
    expect(result.status).toBe(0)
    const findings = result.json.findings as Finding[]
    expect(byCode(findings, 'run-missing')).toEqual([])
    expect(byCode(findings, 'run-ended')).toEqual([])
    const unchecked = byCode(findings, 'runs-unchecked')
    expect(unchecked).toHaveLength(1)
    expect(unchecked[0].level).toBe('info')
  })

  it('F-9: without --runs the fake is never called and no run-* finding appears', () => {
    claimWithWake('thread:w5')
    const map = fakeMap({ 'thread:w5': { stdout: endedJson('thread:w5') } })
    const doctor = cli(map, 'doctor')
    expect(doctor.status).toBe(0)
    expect(doctor.json.findings.filter((finding: Finding) => finding.code.startsWith('run'))).toEqual([])
    const stale = cli(map, 'stale')
    expect(stale.status).toBe(0)
    expect(stale.json).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('F-10: stale --runs lists a recently alive claim whose run ended, with runState', () => {
    const id = claimWithWake('thread:w5')
    expect(
      cli(fakeMap({ 'thread:w5': { stdout: endedJson('thread:w5') } }), 'stale', '--runs', '--hours', '24').json,
    ).toEqual([expect.objectContaining({ id, runState: 'completed' })])
  })

  it('F-11: stale --runs leaves out a recently alive claim whose run is running', () => {
    claimWithWake('thread:w5')
    const result = cli(fakeMap({ 'thread:w5': { stdout: runningJson('thread:w5') } }), 'stale', '--runs')
    expect(result.status).toBe(0)
    expect(result.json).toEqual([])
    expect(t3Calls()).toHaveLength(1)
  })

  it('F-12: a missing t3 binary is not an error: exit 0 and a runs-unchecked info finding', () => {
    claimWithWake('thread:w5')
    const result = cli({ TEAM_BOARD_T3_BIN: join(dir, 'no-such-t3') }, 'doctor', '--runs')
    expect(result.status).toBe(0)
    expect(result.json.ok).toBe(true)
    const unchecked = result.json.findings.filter((finding: Finding) => finding.code === 'runs-unchecked')
    expect(unchecked).toHaveLength(1)
    expect(unchecked[0].level).toBe('info')
  })

  it('F-13: the thread id reaches t3 byte for byte, with its %3A escapes kept', () => {
    const encoded = 'thread:delegated-task:command%3Amcp%3A5f0fd5fa%3Adelegate-task%3A3e1b7b9e'
    claimWithWake(encoded)
    cli(fakeMap({ [encoded]: { stdout: runningJson(encoded) } }), 'doctor', '--runs')
    expect(t3Calls()).toEqual([['thread', 'show', encoded, '--json', '--messages', '0']])
  })

  it('F-14: a hung t3 times out into runs-unchecked in bounded time', () => {
    claimWithWake('thread:slow')
    const started = Date.now()
    const result = cli(
      {
        ...fakeMap({ 'thread:slow': { stdout: runningJson('thread:slow'), sleepMs: 8000 } }),
        TEAM_BOARD_T3_TIMEOUT_MS: '50',
      },
      'doctor',
      '--runs',
    )
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.status).toBe(0)
    const unchecked = result.json.findings.filter((finding: Finding) => finding.code === 'runs-unchecked')
    expect(unchecked).toHaveLength(1)
    expect(unchecked[0].level).toBe('info')
  })
})
