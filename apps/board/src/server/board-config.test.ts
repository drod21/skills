import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PORT, readConfig, tailnetFrom } from './board-config.server'

describe('readConfig', () => {
  it("defaults to the toolkit's CLI and the working directory's project and board, on the board's own port", () => {
    const config = readConfig({ DEREK_SKILLS: '/opt/toolkit' })
    const repo = '/opt/toolkit'
    expect(config).toEqual({
      cli: join(repo, 'scripts', 'team-tasks.mjs'),
      repo,
      project: process.cwd(),
      boardFile: join(process.cwd(), 'tasks.json'),
      node: 'node',
      t3: existsSync(join(homedir(), '.t3', 'bin', 't3')) ? join(homedir(), '.t3', 'bin', 't3') : 't3',
      port: DEFAULT_PORT,
      buildSha: null,
      tailnet: null,
    })
  })

  it('lets a test point the app at another CLI and board', () => {
    const config = readConfig({
      TEAM_BOARD_CLI: '/work/checkout/scripts/team-tasks.mjs',
      TEAM_BOARD_PROJECT: '/work/project',
      TEAM_TASKS_FILE: '/tmp/scratch/tasks.json',
      TEAM_BOARD_BUILD_SHA: 'abc1234',
      PORT: '4791',
    })
    expect(config).toMatchObject({
      cli: '/work/checkout/scripts/team-tasks.mjs',
      repo: '/work/checkout',
      project: '/work/project',
      boardFile: '/tmp/scratch/tasks.json',
      buildSha: 'abc1234',
      port: 4791,
    })
  })

  it("takes the project from the board file's directory, and resolves a relative project", () => {
    expect(readConfig({ TEAM_TASKS_FILE: '/work/project/tasks.json' }).project).toBe('/work/project')
    expect(readConfig({ TEAM_BOARD_PROJECT: 'rel/project' }).project).toBe(resolve('rel/project'))
  })

  it("reads the board from the project's checkout unless TEAM_TASKS_FILE names another", () => {
    expect(readConfig({ TEAM_BOARD_PROJECT: '/work/project' }).boardFile).toBe('/work/project/tasks.json')
  })

  it.each(['0', '65536', 'abc', '47.5', '-1'])('refuses PORT=%s', (port) => {
    expect(() => readConfig({ PORT: port })).toThrow(/board app environment/)
  })

  it('refuses an empty path instead of reading the board from the working directory', () => {
    expect(() => readConfig({ TEAM_TASKS_FILE: '' })).toThrow(/board app environment/)
  })
})

describe('tailnetFrom', () => {
  it('stays off unless both the host and a login are set', () => {
    expect(tailnetFrom(undefined, undefined)).toBeNull()
    expect(tailnetFrom('mac.tail.ts.net', undefined)).toBeNull()
    expect(tailnetFrom('mac.tail.ts.net', ' , ')).toBeNull()
    expect(tailnetFrom('', 'owner@example.com')).toBeNull()
  })

  it('normalizes the host and the logins', () => {
    expect(tailnetFrom(' Mac.Tail.TS.net. ', 'Owner@Example.com, other@example.com ,')).toEqual({
      host: 'mac.tail.ts.net',
      logins: ['owner@example.com', 'other@example.com'],
    })
  })
})
