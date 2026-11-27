import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, 'team-tasks.mjs')
const BRIEFS = join(import.meta.dirname, '..', 'skills/team-coordinator/references/briefs')
const STANDING_LINE =
  'Keep working until the completion criterion holds. A question the spec or the repo can answer is not a reason to stop; answer it and continue.'
const PAIR_LINE = /Paired test tasks?:/

const task = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  role: 'ux-worker',
  title: `task ${id}`,
  status: 'open',
  owner: null,
  after: [],
  route: 'sonnet_patch',
  accept: 'acceptance check',
  ...over,
})
const buildTask = (over: Record<string, unknown> = {}) => task(1, { title: 'Add X', tag: 'x', ...over })
const testTask = (id: number, over: Record<string, unknown> = {}) =>
  task(id, { role: 'qa-worker', title: 'Lock tests for X', tag: 'x', ...over })

let dir: string
let board: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-tasks-brief-pair-'))
  board = join(dir, 'tasks.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const seed = (...tasks: ReturnType<typeof task>[]) =>
  writeFileSync(board, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`)

function brief(...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'brief', ...args], {
    encoding: 'utf8',
    env: { ...process.env, TEAM_TASKS_FILE: board },
  })
}

const pairLines = (stdout: string) => stdout.split('\n').filter((line) => PAIR_LINE.test(line))

function expectRefusedForMissingPair(result: ReturnType<typeof brief>) {
  expect(result.status, result.stdout).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/pair/i)
  expect(result.stderr).toMatch(/test/i)
}

function expectBuildBrief(result: ReturnType<typeof brief>) {
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('# Build brief: #1 Add X')
  expect(result.stdout).toContain('Board acceptance: acceptance check')
  expect(result.stdout).toContain('<allowed files>')
  expect(result.stdout).toContain('Make the locked tests pass.')
  expect(result.stdout).toContain('Return the head, changed files, the green run, evidence paths and blockers.')
  expect(result.stdout).not.toMatch(/\{\{\w+\}\}/)
}

describe('build brief without a paired test task', () => {
  it('is refused when the board holds only the build task, and leaves the board alone', () => {
    seed(buildTask())
    const before = readFileSync(board, 'utf8')
    expectRefusedForMissingPair(brief('1', '--kind', 'build'))
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('does not pair with a cancelled test task', () => {
    seed(buildTask(), testTask(2, { status: 'cancelled' }))
    expectRefusedForMissingPair(brief('1', '--kind', 'build'))
  })

  it('does not pair with a same-tag task of another role', () => {
    seed(buildTask(), testTask(2, { role: 'backend-worker' }))
    expectRefusedForMissingPair(brief('1', '--kind', 'build'))
  })

  it('does not pair with a test task of another tag or of no tag', () => {
    seed(buildTask(), testTask(2, { tag: 'y' }), testTask(3, { tag: undefined }))
    expectRefusedForMissingPair(brief('1', '--kind', 'build'))
  })

  it('gives an untagged build task no pair, even beside an untagged test task', () => {
    seed(buildTask({ tag: undefined }), testTask(2, { tag: undefined }))
    expectRefusedForMissingPair(brief('1', '--kind', 'build'))
  })

  it('does not pair a qa-worker build task with itself', () => {
    seed(buildTask({ role: 'qa-worker' }))
    expectRefusedForMissingPair(brief('1', '--kind', 'build'))
  })
})

describe('build brief with a paired test task', () => {
  it('prints the build brief plus one line naming the pair', () => {
    seed(buildTask(), testTask(12))
    const result = brief('1', '--kind', 'build')
    expectBuildBrief(result)
    expect(pairLines(result.stdout)).toHaveLength(1)
    expect(pairLines(result.stdout)[0]).toContain('Paired test task: 12 (Lock tests for X)')
  })

  it.each(['open', 'claimed', 'done'])('counts a %s test task as the pair', (status) => {
    seed(buildTask(), testTask(12, { status, owner: status === 'claimed' ? 'tester' : null }))
    const result = brief('1', '--kind', 'build')
    expectBuildBrief(result)
    expect(pairLines(result.stdout)).toHaveLength(1)
    expect(pairLines(result.stdout)[0]).toContain('12 (Lock tests for X)')
  })

  it('names every pair on the same line and leaves out tasks that are not pairs', () => {
    seed(
      buildTask(),
      testTask(12),
      testTask(13, { title: 'Verify X on device' }),
      testTask(14, { title: 'Dropped tests', status: 'cancelled' }),
      testTask(15, { title: 'Tests for Y', tag: 'y' }),
      testTask(16, { title: 'Server half of X', role: 'backend-worker' }),
    )
    const result = brief('1', '--kind', 'build')
    expect(result.status, result.stderr).toBe(0)
    const lines = pairLines(result.stdout)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('12 (Lock tests for X)')
    expect(lines[0]).toContain('13 (Verify X on device)')
    for (const title of ['Dropped tests', 'Tests for Y', 'Server half of X']) expect(result.stdout).not.toContain(title)
  })

  it('keeps a pair title with line breaks on the one pair line', () => {
    seed(buildTask(), testTask(12, { title: 'Lock tests\nfor X' }))
    const result = brief('1', '--kind', 'build')
    expect(result.status, result.stderr).toBe(0)
    expect(pairLines(result.stdout)).toHaveLength(1)
    expect(pairLines(result.stdout)[0]).toContain('12 (Lock tests for X)')
  })
})

describe('--no-test-pair', () => {
  it('prints the build brief without a pair when a reason is given', () => {
    seed(buildTask())
    const before = readFileSync(board, 'utf8')
    const result = brief('1', '--kind', 'build', '--no-test-pair', '--reason', 'docs only change')
    expectBuildBrief(result)
    expect(result.stdout).not.toMatch(/Paired test tasks?: \d/)
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('works for an untagged build task', () => {
    seed(buildTask({ tag: undefined }))
    expectBuildBrief(brief('1', '--kind', 'build', '--no-test-pair', '--reason', 'docs only change'))
  })

  it('is refused without --reason', () => {
    seed(buildTask())
    const result = brief('1', '--kind', 'build', '--no-test-pair')
    expect(result.status, result.stdout).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('takes no')
    expect(result.stderr).toContain('--reason')
  })

  it('refuses --reason without --no-test-pair, even when a pair exists', () => {
    seed(buildTask(), testTask(12))
    const result = brief('1', '--kind', 'build', '--reason', 'docs only change')
    expect(result.status, result.stdout).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('takes no')
    expect(result.stderr).toContain('--no-test-pair')
  })
})

describe('the other brief kinds', () => {
  it.each([
    ['test', '# Test brief: #1 Add X'],
    ['review', '#1 Add X'],
    ['verify', '#1 Add X'],
  ])('prints a %s brief with no pair required and no pair line', (kind, heading) => {
    for (const tasks of [[buildTask()], [buildTask({ tag: undefined })], [buildTask(), testTask(12)]]) {
      seed(...tasks)
      const result = brief('1', '--kind', kind)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(heading)
      expect(pairLines(result.stdout)).toEqual([])
    }
  })
})

describe('standing line in the brief templates', () => {
  it.each(['build', 'test'])('is one whole line of %s.md and of the printed brief', (kind) => {
    const wholeLine = (text: string) => text.split('\n').filter((line) => line.replace(/^- /, '') === STANDING_LINE)
    expect(wholeLine(readFileSync(join(BRIEFS, `${kind}.md`), 'utf8'))).toHaveLength(1)
    seed(buildTask(), testTask(12))
    const result = brief('1', '--kind', kind)
    expect(result.status, result.stderr).toBe(0)
    expect(wholeLine(result.stdout)).toHaveLength(1)
  })
})
