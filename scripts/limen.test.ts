import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const hook = join(root, 'hooks/ask-annoyance.mjs')

function runHook(input: unknown, stateDir: string) {
  return spawnSync('node', [hook], {
    input: JSON.stringify(input),
    env: { ...process.env, LIMEN_STATE_DIR: stateDir, LIMEN_DISABLE: '' },
    encoding: 'utf8',
  })
}

describe('ask-annoyance hook', () => {
  it('asks a session once and names no log location', () => {
    const state = mkdtempSync(join(tmpdir(), 'limen-state-'))
    const first = runHook({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false }, state)
    expect(first.status).toBe(0)
    const out = JSON.parse(first.stdout)
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('Did anything about the system annoy you?')
    expect(out.reason).toContain('limen complain --session s1')
    expect(out.reason).not.toMatch(/complain\.md|Application Support|\/etc\/limen/)

    const again = runHook({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false }, state)
    expect(again.stdout).toBe('')
  })

  it('never blocks a stop the hook already continued', () => {
    const state = mkdtempSync(join(tmpdir(), 'limen-state-'))
    const r = runHook({ session_id: 's2', hook_event_name: 'Stop', stop_hook_active: true }, state)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(readdirSync(state)).toEqual([])
  })

  it('asks each subagent of a session separately', () => {
    const state = mkdtempSync(join(tmpdir(), 'limen-state-'))
    const a = runHook({ session_id: 's3', hook_event_name: 'SubagentStop', agent_id: 'a1' }, state)
    const b = runHook({ session_id: 's3', hook_event_name: 'SubagentStop', agent_id: 'a2' }, state)
    const main = runHook({ session_id: 's3', hook_event_name: 'Stop' }, state)
    for (const r of [a, b, main]) expect(JSON.parse(r.stdout).decision).toBe('block')
  })

  it('ignores malformed input', () => {
    const state = mkdtempSync(join(tmpdir(), 'limen-state-'))
    const r = spawnSync('node', [hook], { input: 'not json', env: { ...process.env, LIMEN_STATE_DIR: state }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('limen binary', () => {
  let dir: string
  let log: string
  let bin: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'limen-bin-'))
    log = join(dir, 'complain.md')
    bin = join(dir, 'limen')
    writeFileSync(log, '# complain\n')
    execFileSync('/usr/bin/clang', ['-O2', '-Wall', '-Werror', `-DLIMEN_FILE="${log}"`, join(root, 'limen/limen.c'), '-o', bin])
    chmodSync(bin, 0o111)
  })

  afterAll(() => chmodSync(bin, 0o755))

  it('runs execute-only and appends one flattened line without printing the path', () => {
    const r = spawnSync(bin, ['complain', '--session', 'abc', '--project', 'demo', 'tests\nwere   slow'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('noted\n')
    expect(r.stdout + r.stderr).not.toContain(dir)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('# complain')
    expect(lines[1]).toMatch(/^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4} \| session abc \| demo \| tests were slow$/)
  })

  it('tags the project from the git checkout', () => {
    const r = spawnSync(bin, ['complain', 'no project flag'], { cwd: root, encoding: 'utf8', env: { ...process.env, LIMEN_SESSION_ID: 'env-sid' } })
    expect(r.status).toBe(0)
    expect(readFileSync(log, 'utf8')).toContain('| session env-sid | derek-skills | no project flag')
  })

  it('refuses an empty sentence or unknown command', () => {
    expect(spawnSync(bin, ['complain', '   ']).status).toBe(64)
    expect(spawnSync(bin, ['read']).status).toBe(64)
    expect(spawnSync(bin, []).status).toBe(64)
  })

  it('cannot be read by its caller', () => {
    expect(() => readFileSync(bin)).toThrow(/EACCES/)
  })
})
