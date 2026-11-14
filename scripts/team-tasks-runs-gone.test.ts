import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, 'team-tasks.mjs')
const FAKE = join(import.meta.dirname, 'team-tasks-runs.fake-t3.mjs')

type Finding = { level: string; code: string; message: string; id?: number }

let dir: string
let board: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-tasks-runs-gone-'))
  board = join(dir, 'tasks.json')
  chmodSync(FAKE, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function cli(map: Record<string, { stderr?: string; exit?: number }>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAM_TASKS_FILE: board,
      TEAM_BOARD_T3_BIN: FAKE,
      TEAM_BOARD_FAKE_MAP: JSON.stringify(map),
    },
  })
  return { status: result.status, json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined }
}

function claimWithWake(wake: string) {
  const added = cli({}, 'add', 'qa-worker', `task for ${wake}`, '--accept', 'the work is done')
  expect(added.status).toBe(0)
  const id = added.json.id as number
  expect(cli({}, 'claim', 'qa-worker', 'worker', '--id', String(id), '--wake', wake).status).toBe(0)
  return id
}

const codes = (findings: Finding[], code: string) => findings.filter((finding) => finding.code === code)

describe('doctor --runs reads only the exact unknown-thread reply as missing', () => {
  it('other T3 failures ending in "is no longer available." stay unchecked', () => {
    claimWithWake('thread:cred')
    claimWithWake('thread:other')
    claimWithWake('thread:exit2')
    const result = cli(
      {
        'thread:cred': { exit: 1, stderr: 'Bootstrap credential is no longer available.\n' },
        'thread:other': { exit: 1, stderr: 'Thread thread:someone-else is no longer available.\n' },
        'thread:exit2': { exit: 2, stderr: 'Thread thread:exit2 is no longer available.\n' },
      },
      'doctor',
      '--runs',
    )
    expect(result.status).toBe(0)
    const findings = result.json.findings as Finding[]
    expect(codes(findings, 'run-missing')).toEqual([])
    expect(codes(findings, 'run-ended')).toEqual([])
    expect(codes(findings, 'runs-unchecked')).toHaveLength(1)
  })

  it('the exact reply after an earlier stderr line is still missing', () => {
    const id = claimWithWake('thread:gone')
    const result = cli(
      { 'thread:gone': { exit: 1, stderr: 'warning: something\nThread thread:gone is no longer available.\n' } },
      'doctor',
      '--runs',
    )
    const missing = codes(result.json.findings as Finding[], 'run-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0].id).toBe(id)
  })
})
