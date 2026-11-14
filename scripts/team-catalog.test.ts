import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveBoardFile } from './team-board-path.mjs'
import { loadExtraRoles, mergeRoles, ROLES } from './team-catalog.mjs'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-catalog-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.TEAM_TASKS_FILE
})

describe('roles', () => {
  it('ships the generic roles', () => {
    expect(Object.keys(ROLES)).toEqual(
      expect.arrayContaining([
        'lead',
        'backend-worker',
        'ux-worker',
        'security-worker',
        'perf-worker',
        'qa-worker',
        'specialist-worker',
      ]),
    )
  })

  it('merges a project roles file and never replaces a base role', () => {
    const file = join(dir, 'team-roles.json')
    writeFileSync(file, JSON.stringify({ 'data-worker': 'Pipelines and warehouse models', 'qa-worker': 'overridden' }))
    const merged = mergeRoles(loadExtraRoles(file))
    expect(merged['data-worker']).toBe('Pipelines and warehouse models')
    expect(merged['qa-worker']).toBe(ROLES['qa-worker'])
    expect(Object.keys(merged).slice(0, 3)).toEqual(Object.keys(ROLES).slice(0, 3))
  })

  it('ignores a missing roles file and refuses a bad one', () => {
    expect(loadExtraRoles(join(dir, 'absent.json'))).toEqual({})
    expect(loadExtraRoles(null)).toEqual({})
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ 'Data Worker': 'x' }))
    expect(() => loadExtraRoles(bad)).toThrow(/lowercase letters, digits and hyphens/)
    writeFileSync(bad, JSON.stringify({ ok: 3 }))
    expect(() => loadExtraRoles(bad)).toThrow(/must map role names to descriptions/)
    writeFileSync(bad, '{')
    expect(() => loadExtraRoles(bad)).toThrow(/not valid JSON/)
  })

  it('loads TEAM_ROLES_FILE at import and lets the CLI add a task under that role', () => {
    const roles = join(dir, 'roles.json')
    writeFileSync(roles, JSON.stringify({ 'data-worker': 'Pipelines' }))
    const board = join(dir, 'tasks.json')
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [join(import.meta.dirname, 'team-tasks.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, TEAM_TASKS_FILE: board, TEAM_ROLES_FILE: roles },
      })
    expect(JSON.parse(run('add', 'data-worker', 'Backfill', '--accept', 'rows match')).role).toBe('data-worker')
  })

  it('reads team-roles.json beside the board when TEAM_ROLES_FILE is unset', () => {
    const board = join(dir, 'tasks.json')
    writeFileSync(join(dir, 'team-roles.json'), JSON.stringify({ 'infra-worker': 'Deploys' }))
    const env = { ...process.env, TEAM_TASKS_FILE: board } as Record<string, string | undefined>
    delete env.TEAM_ROLES_FILE
    const out = execFileSync(process.execPath, [join(import.meta.dirname, 'team-tasks.mjs'), 'add', 'infra-worker', 'Ship', '--accept', 'live'], {
      encoding: 'utf8',
      env,
    })
    expect(JSON.parse(out).role).toBe('infra-worker')
  })
})

describe('board path', () => {
  it('uses TEAM_TASKS_FILE first', () => {
    process.env.TEAM_TASKS_FILE = join(dir, 'custom.json')
    expect(resolveBoardFile()).toBe(join(dir, 'custom.json'))
  })

  it('finds the board beside the git common dir of the working directory, shared by worktrees', () => {
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    const tree = join(dir, 'tree')
    git('worktree', 'add', '-q', tree)
    const probe = `import { resolveBoardFile } from ${JSON.stringify(join(import.meta.dirname, 'team-board-path.mjs'))}; console.log(resolveBoardFile())`
    const from = (cwd: string) =>
      execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, TEAM_TASKS_FILE: '' },
      }).trim()
    expect(from(repo)).toBe(join(repo, 'tasks.json'))
    expect(from(tree)).toBe(join(repo, 'tasks.json'))
  })

  it('falls back to tasks.json in the working directory outside git', () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    const probe = `import { resolveBoardFile } from ${JSON.stringify(join(import.meta.dirname, 'team-board-path.mjs'))}; console.log(resolveBoardFile())`
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: plain,
      encoding: 'utf8',
      env: { ...process.env, TEAM_TASKS_FILE: '', GIT_CEILING_DIRECTORIES: dir },
    }).trim()
    expect(out).toBe(join(plain, 'tasks.json'))
  })
})
