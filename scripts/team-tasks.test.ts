import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHECKS, HOLDS, ROUTES } from './jev-route.lib.ts'
import {
  JEV_CHECKS,
  JEV_HOLDS,
  KNOWN_ROUTES,
  currentCheck,
  doneBlockers,
  normalizeVerdict,
  parseRun,
} from './team-tasks.lib.mjs'

const CLI = join(import.meta.dirname, 'team-tasks.mjs')

interface RunLink {
  kind: string
  ref: string
  at?: string
}
interface JevVerdict {
  route: string
  jevRoute: string
  confidence: number
  holds: string[]
  roleFits: boolean
  suggestedRole: string | null
  check: string | null
  reasons: string[]
  at?: string
}
interface DecisionRecord {
  at: string
  kind: string
  from?: string | null
  to?: string
  reason?: string | null
  summary?: string
  ref?: string | null
  by?: string | null
  verdict?: JevVerdict | null
}
interface Task {
  id: number
  role: string
  title: string
  status: 'open' | 'claimed' | 'done' | 'cancelled'
  owner: string | null
  after: number[]
  route: string | null
  claimedAt?: string
  heartbeatAt?: string
  doneAt?: string
  jev?: JevVerdict
  decisions?: DecisionRecord[]
  evidence?: string[]
  run?: RunLink
  accept?: string
  tag?: string
}

const ACCEPT = 'acceptance check'

function withAccept(args: string[]) {
  if (args[0] !== 'add' || args.includes('--accept')) return args
  const role = args[1]
  if (!role || role === 'lead' || role.startsWith('--')) return args
  return [...args, '--accept', ACCEPT]
}

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  role: 'ux-worker',
  title: `task ${id}`,
  status: 'open',
  owner: null,
  after: [],
  route: 'sonnet_patch',
  ...over,
})

let dir: string
let board: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-tasks-'))
  board = join(dir, 'tasks.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const seed = (...tasks: Task[]) => writeFileSync(board, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`)
const read = (): Task[] => JSON.parse(readFileSync(board, 'utf8')).tasks
const byId = (id: number) => read().find((candidate) => candidate.id === id)!
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

describe('wake addresses', () => {
  it('tracks claim wake addresses through heartbeat, release, cancel and done', () => {
    seed(task(1), task(2), task(3))
    const claim = cli('claim', 'ux-worker', 'worker', '--id', '1', '--wake', 'thread:one').json
    expect(claim.wake).toEqual({ threadId: 'thread:one', at: claim.claimedAt })
    expect(cli('heartbeat', '1', '--owner', 'worker', '--wake', 'thread:two').json.wake).toEqual({
      threadId: 'thread:two',
      at: claim.claimedAt,
    })
    const released = cli('release', '1', '--by', 'lead', '--reason', 'stopped').json
    expect(released.wake).toBeUndefined()
    expect(released.decisions.at(-1)).toMatchObject({
      kind: 'release',
      by: 'lead',
      reason: 'stopped',
      wake: { threadId: 'thread:two', at: claim.claimedAt },
    })
    const second = cli('claim', 'ux-worker', 'worker', '--id', '2', '--wake', 'thread:cancel').json
    const cancelled = cli('cancel', '2', '--by', 'lead', '--reason', 'cancelled').json
    expect(cancelled.wake).toBeUndefined()
    expect(cancelled.decisions.at(-1)).toMatchObject({
      kind: 'cancel',
      by: 'lead',
      reason: 'cancelled',
      wake: second.wake,
    })
    const third = cli('claim', 'ux-worker', 'worker', '--id', '3', '--wake', 'thread:done').json
    expect(cli('done', '3', '--owner', 'worker').json.wake).toEqual(third.wake)
  })

  it('heals stale wake addresses and manages lead wake addresses and doctor warnings', () => {
    seed(task(1))
    const claim = cli('claim', 'ux-worker', 'worker', '--id', '1').json
    let findings = cli('doctor').json.findings
    expect(findings.map((item: { code: string }) => item.code)).toEqual(
      expect.arrayContaining(['unaddressed-claim', 'no-lead-wake']),
    )
    expect(cli('lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli('lead-wake', 'thread:area', '--task', '1', '--by', 'lead').json.leadWake).toBeDefined()
    expect(cli('heartbeat', '1', '--wake', 'thread:worker').json.wake.at).toBe(claim.claimedAt)
    findings = cli('doctor').json.findings
    expect(findings.map((item: { code: string }) => item.code)).not.toContain('unaddressed-claim')
    expect(findings.map((item: { code: string }) => item.code)).not.toContain('no-lead-wake')
    const data = JSON.parse(readFileSync(board, 'utf8'))
    data.tasks[0].wake.at = 'stale'
    writeFileSync(board, JSON.stringify(data))
    expect(cli('heartbeat', '1').json.wake).toBeUndefined()
    expect(cli('lead-wake', '--clear', '--task', '1', '--by', 'lead').json.leadWake).toBeUndefined()
    expect(cli('lead-wake', '--clear', '--by', 'lead').status).toBe(0)
    expect(JSON.parse(readFileSync(board, 'utf8')).leadWake).toBeUndefined()
  })

  it('rejects invalid wake thread IDs without changing the claim', () => {
    seed(task(1))
    for (const value of ['', 'two words', 'x'.repeat(513)]) {
      expect(cli('claim', 'ux-worker', 'worker', '--id', '1', '--wake', value).status).toBe(1)
      expect(byId(1).status).toBe('open')
      expect(cli('lead-wake', value, '--by', 'lead').status).toBe(1)
    }
  })
})

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...withAccept(args)], {
    encoding: 'utf8',
    env: { ...process.env, TEAM_TASKS_FILE: board },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    get json() {
      return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
    },
  }
}

describe('existing commands keep their shape', () => {
  it('adds with the legacy argument order and prints the task', () => {
    seed(task(1, { status: 'done' }))
    const added = cli('add', 'qa-worker', 'Verify', 'the', 'fix', '--after', '1', '--route', 'haiku_fork')
    expect(added.status).toBe(0)
    expect(added.json).toEqual({
      id: 2,
      role: 'qa-worker',
      title: 'Verify the fix',
      status: 'open',
      owner: null,
      after: [1],
      route: 'haiku_fork',
      accept: ACCEPT,
    })
  })

  it('claims the first eligible task for a role, and prints null when there is none', () => {
    seed(task(1, { route: 'needs_lead' }), task(2, { after: [4] }), task(3, { role: 'qa-worker' }), task(4), task(5))
    expect(cli('claim', 'ux-worker', 'me').json.id).toBe(4)
    expect(cli('claim', 'ux-worker', 'me2').json.id).toBe(5)
    const none = cli('claim', 'ux-worker', 'me3')
    expect(none.status).toBe(0)
    expect(none.json).toBeNull()
  })
})

describe('claim --id', () => {
  it('claims exactly that task even when an older one of the same role is open', () => {
    seed(task(1, { title: 'another team' }), task(2))
    const claimed = cli('claim', 'ux-worker', 'me', '--id', '2')
    expect(claimed.json).toMatchObject({ id: 2, status: 'claimed', owner: 'me' })
    expect(byId(1).status).toBe('open')
  })

  it.each([
    ['wrong role', 'qa-worker', 'belongs to role ux-worker'],
    ['already claimed', 'ux-worker', 'is claimed'],
    ['held for the lead', 'ux-worker', 'held for the lead'],
    ['waiting on a task', 'ux-worker', 'waiting on task 1'],
  ])('refuses a task that is %s and changes nothing', (label, role, reason) => {
    const tasks = {
      'wrong role': task(2),
      'already claimed': task(2, { status: 'claimed', owner: 'x' }),
      'held for the lead': task(2, { route: 'needs_lead' }),
      'waiting on a task': task(2, { after: [1] }),
    }[label]!
    seed(task(1), tasks)
    const before = readFileSync(board, 'utf8')
    const result = cli('claim', role, 'me', '--id', '2')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(reason)
    expect(readFileSync(board, 'utf8')).toBe(before)
  })
})

describe('done', () => {
  it('requires a claimed task, honours --owner, and is idempotent', () => {
    seed(task(1), task(2, { status: 'claimed', owner: 'me' }))
    expect(cli('done', '1').status).toBe(1)
    expect(byId(1).status).toBe('open')
    expect(cli('done', '2', '--owner', 'someone-else').status).toBe(1)
    expect(byId(2).status).toBe('claimed')
    expect(cli('done', '2', '--owner', 'me').json).toMatchObject({ id: 2, status: 'done' })
    expect(cli('done', '2').status).toBe(0)
  })

  it('--force completes an unclaimed task', () => {
    seed(task(1))
    expect(cli('done', '1', '--force').json.status).toBe('done')
  })

  it('checks done --owner on an already-done task unless --force', () => {
    seed(task(1, { status: 'done', owner: 'me', evidence: ['docs/a.md'] }), task(2, { claimedAt: hoursAgo(1) }))
    const before = readFileSync(board, 'utf8')
    const other = cli('done', '1', '--owner', 'other')
    expect(other.status).toBe(1)
    expect(other.stderr).toContain('owned by me, not other')
    expect(other.stderr).not.toContain('healed:')
    const otherEvidence = cli('done', '1', '--owner', 'other', '--evidence', 'docs/b.md')
    expect(otherEvidence.status).toBe(1)
    expect(otherEvidence.stderr).toContain('owned by me, not other')
    expect(otherEvidence.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(before)
    expect(cli('done', '1').status).toBe(0)
    expect(cli('done', '1', '--owner', 'me', '--evidence', 'docs/b.md').status).toBe(0)
    expect(byId(1).evidence).toEqual(['docs/a.md', 'docs/b.md'])
    expect(byId(1).owner).toBe('me')
    expect(cli('done', '1', '--owner', 'other', '--force', '--evidence', 'docs/c.md').status).toBe(0)
    expect(byId(1).evidence).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
    expect(byId(1).owner).toBe('me')
  })

  it('lets any --owner append evidence to a legacy done task with no owner', () => {
    seed(task(1, { status: 'done', owner: null, evidence: ['docs/a.md'] }))
    const result = cli('done', '1', '--owner', 'lead', '--evidence', 'docs/b.md')
    expect(result.status).toBe(0)
    expect(byId(1).evidence).toEqual(['docs/a.md', 'docs/b.md'])
    expect(byId(1).owner).toBeNull()
  })

  it.each(['done', 'release', 'cancel', 'heartbeat'])(
    '%s on a missing task exits 1 instead of printing null',
    (command) => {
      seed(task(1))
      const result = cli(command, '99')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('task 99 does not exist')
    },
  )
})

describe('read-only commands never write', () => {
  it('list leaves the file and its directory untouched, and filters', () => {
    seed(task(1), task(2, { role: 'qa-worker', status: 'done' }))
    const before = readFileSync(board, 'utf8')
    const entries = readdirSync(dir)
    expect(cli('list', '--json').json.map((t: Task) => t.id)).toEqual([1])
    expect(cli('list', '--all', '--json').json).toHaveLength(2)
    expect(cli('list', '--status', 'done', '--json').json.map((t: Task) => t.id)).toEqual([2])
    expect(cli('list', '--role', 'ux-worker', '--json').json.map((t: Task) => t.id)).toEqual([1])
    expect(readFileSync(board, 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(entries)
  })
})

describe('compact reads', () => {
  const verdict = {
    route: 'sonnet_patch',
    jevRoute: 'sonnet_patch',
    confidence: 0.9,
    holds: [],
    roleFits: true,
    suggestedRole: null,
    check: null,
    reasons: ['small'],
    answers: { scope: { score: 0.2 } },
  }

  it('list prints one line per task with its id, status, role, owner, route, dependencies and title', () => {
    seed(
      task(1, { title: 'Fix the login copy', jev: verdict }),
      task(2, { status: 'claimed', owner: 'w2', after: [1], tag: 'auth', title: 'Wire magic links' }),
      task(3, { status: 'done', title: 'Old work' }),
    )
    const result = cli('list')
    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      '#1 open ux-worker - sonnet_patch Fix the login copy',
      '#2 claimed ux-worker w2 sonnet_patch after=1 tag=auth Wire magic links',
    ])
  })

  it('list --json prints the full tasks', () => {
    seed(task(1, { jev: verdict }))
    expect(cli('list', '--json', '--json').json).toEqual([task(1, { jev: verdict })])
  })

  it('show leaves out raw Jev answers unless --full', () => {
    seed(task(1, { jev: verdict }))
    const { answers, ...rest } = verdict
    expect(cli('show', '1').json.jev).toEqual({ ...rest, answersOmitted: 'show 1 --full' })
    expect(cli('show', '1', '--full').json.jev).toEqual(verdict)
  })

  it('list keeps a title or owner with newlines and spaces on its own line and columns', () => {
    seed(task(1, { status: 'claimed', owner: 'w1\n#55 open', title: 'Harmless\n#99 open lead - lead_workflow\x1b[2J' }))
    expect(cli('list').stdout).toBe('#1 claimed ux-worker w1_#55_open sonnet_patch Harmless #99 open lead - lead_workflow [2J\n')
  })

  it('--help and -h print the usage', () => {
    for (const flag of ['--help', '-h']) {
      const result = cli(flag)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('list [--all]')
    }
  })

  it('an unknown or missing command prints the command names, and help <command> prints that command only', () => {
    seed(task(1))
    for (const args of [['bogus'], []]) {
      const result = cli(...args)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('help <command>')
      expect(result.stderr).toContain('evidence')
      expect(result.stderr.length).toBeLessThan(1200)
    }
    const evidence = cli('help', 'evidence')
    expect(evidence.status).toBe(0)
    expect(evidence.stdout).toContain('evidence <id> [--supporting] <item...>')
    expect(evidence.stdout).not.toContain('decide <id>')
    expect(cli('help').stdout).not.toContain('Decision policy')
    expect(cli('help').stdout).toContain('help policy')
    expect(cli('help', 'policy').stdout).toContain('Decision policy')
    expect(cli('help', 'policy').stdout).toContain('worker -> Jev')
    expect(cli('help', 'bogus').status).toBe(1)
  })
})

describe('brief', () => {
  const executor = { id: 'codex:model-x', providerInstanceId: 'codex', model: 'model-x', options: { effort: 'high' }, source: 'jev' }
  const routed = { route: 'terra_patch', jevRoute: 'terra_patch', confidence: 0.9, holds: [], roleFits: true, suggestedRole: null, check: null, reasons: [], executor }

  it('fills a build brief from the board and leaves the lead slots open', () => {
    seed(task(1), task(2, { title: 'Add the export button', accept: 'export.test.ts passes', after: [1], tag: 'exports', route: 'terra_patch', jev: routed }))
    const before = readFileSync(board, 'utf8')
    const result = cli('brief', '2', '--kind', 'build')
    expect(result.status, result.stderr).toBe(0)
    for (const text of [
      '#2 Add the export button',
      'export.test.ts passes',
      'terra_patch',
      'codex:model-x',
      'after 1',
      `node ${CLI} claim ux-worker <owner> --id 2`,
      'Guards:',
      'Older tests changed:',
      '<allowed files>',
    ])
      expect(result.stdout).toContain(text)
    expect(result.stdout).not.toMatch(/\{\{\w+\}\}/)
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('names no executor once a lead re-routes or holds the task, and says the verdict had none', () => {
    seed(
      task(1, { route: 'sonnet_patch', jev: routed }),
      task(2, { route: 'needs_lead', jev: { ...routed, route: 'needs_lead' } }),
      task(3, { route: 'terra_patch', jev: { ...routed, executor: null } }),
    )
    const rerouted = cli('brief', '1', '--kind', 'build').stdout
    expect(rerouted).not.toContain('codex:model-x')
    expect(rerouted).toContain('jev-executors.catalog.mjs')
    expect(cli('brief', '2', '--kind', 'build').stdout).toContain('executor none: the route is held')
    expect(cli('brief', '3', '--kind', 'build').stdout).toContain('executor none: the verdict offered none')
  })

  it('tells the lead how to pick an executor for a re-route to a route with no catalog tier', () => {
    seed(task(1, { route: 'claude_review', jev: routed }), task(2, { route: 'terra_patch', jev: { ...routed, route: 'needs_lead', executor: null } }))
    const untiered = cli('brief', '1', '--kind', 'review').stdout
    expect(untiered).toContain('claude_review has no tier in jev-executors.catalog.mjs')
    expect(untiered).toContain('pick one runnable catalog pair and record it in this brief')
    expect(untiered).not.toContain('first available claude_review entry')
    seed(task(1, { route: 'claude_review' }), task(2, { route: 'sol_patch', jev: { ...routed, route: 'sol_patch', executor: null } }), task(3, { route: 'terra_patch', jev: { ...routed, route: 'needs_lead', executor: null } }))
    for (const id of ['1', '2']) expect(cli('brief', id, '--kind', 'build').stdout).toContain('has no tier in jev-executors.catalog.mjs; pick one runnable catalog pair')
    const fromHold = cli('brief', '3', '--kind', 'build').stdout
    expect(fromHold).toContain('the verdict held this task')
    expect(fromHold).toContain('first available terra_patch entry')
  })

  it('puts the scoring instructions and the fix threshold in a review brief', () => {
    seed(task(1, { role: 'qa-worker' }))
    const result = cli('brief', '1', '--kind', 'review')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('frequency x impact >= 20')
    expect(result.stdout).toContain('frequency 0')
    expect(result.stdout).toContain('jev-ask.ts')
  })

  it('prints test and verify briefs', () => {
    seed(task(1))
    expect(cli('brief', '1', '--kind', 'test').stdout).toContain('red run')
    expect(cli('brief', '1', '--kind', 'verify').stdout).toContain('never ask the owner')
  })

  it('refuses a missing or unknown kind and a missing task', () => {
    seed(task(1))
    expect(cli('brief', '1').stderr).toContain('usage: brief <id> --kind <test|build|review|verify>')
    expect(cli('brief', '1', '--kind', 'deploy').stderr).toContain('usage: brief')
    expect(cli('brief', '9', '--kind', 'build').status).toBe(1)
  })
})

describe('healing', () => {
  it('keeps a backup that matches the last board it wrote', () => {
    seed(task(1))
    cli('add', 'ux-worker', 'next')
    expect(readFileSync(`${board}.bak`, 'utf8')).toBe(readFileSync(board, 'utf8'))
    cli('add', 'ux-worker', 'after')
    expect(readFileSync(`${board}.bak`, 'utf8')).toBe(readFileSync(board, 'utf8'))
  })

  it('restores a corrupt board from the backup, keeps the broken file, and says so', () => {
    seed(task(1))
    cli('add', 'ux-worker', 'second')
    writeFileSync(board, '{"tasks": [{"id": 1, "sta')
    const result = cli('add', 'ux-worker', 'third')
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('healed')
    expect(read().map((t) => t.id)).toEqual([1, 2, 3])
    const quarantined = readdirSync(dir).filter((name) => name.startsWith('tasks.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]!), 'utf8')).toBe('{"tasks": [{"id": 1, "sta')
  })

  it('a read-only command does not repair, and names the fix', () => {
    seed(task(1))
    cli('add', 'ux-worker', 'second')
    writeFileSync(board, 'not json')
    const result = cli('list')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('doctor --fix')
    expect(readFileSync(board, 'utf8')).toBe('not json')
  })

  it('with no usable backup it fails and invents no empty board', () => {
    writeFileSync(board, 'not json')
    const result = cli('add', 'ux-worker', 'x')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no usable tasks.json.bak')
    expect(readFileSync(board, 'utf8')).toBe('not json')
  })

  it('breaks a lock whose owner process is gone', () => {
    seed(task(1))
    const gone = spawnSync(process.execPath, ['-e', '']).pid
    mkdirSync(`${board}.lock`)
    writeFileSync(
      join(`${board}.lock`, 'owner'),
      JSON.stringify({ pid: gone, token: 'dead', at: new Date().toISOString() }),
    )
    const result = cli('add', 'ux-worker', 'x')
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('broke a stale board lock')
    expect(existsSync(`${board}.lock`)).toBe(false)
  })

  it('breaks an old lock left by the previous script version (no owner file)', () => {
    seed(task(1))
    mkdirSync(`${board}.lock`)
    const old = new Date(Date.now() - 120_000)
    utimesSync(`${board}.lock`, old, old)
    expect(cli('add', 'ux-worker', 'x').status).toBe(0)
    expect(existsSync(`${board}.lock`)).toBe(false)
  })

  it("removes a dead writer's temp file and keeps a live writer's", () => {
    seed(task(1))
    const gone = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(`${board}.${gone}.tmp`, '{')
    writeFileSync(`${board}.${process.pid}.tmp`, '{')
    cli('add', 'ux-worker', 'x')
    expect(existsSync(`${board}.${gone}.tmp`)).toBe(false)
    expect(existsSync(`${board}.${process.pid}.tmp`)).toBe(true)
  })

  it('hands out unique ids to parallel adds', async () => {
    seed(task(1, { status: 'done' }))
    const runs = Array.from(
      { length: 12 },
      (_, index) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [CLI, 'add', 'ux-worker', `parallel ${index}`, '--accept', ACCEPT], {
            env: { ...process.env, TEAM_TASKS_FILE: board },
            stdio: 'ignore',
          })
          child.on('close', resolve)
        }),
    )
    expect(await Promise.all(runs)).toEqual(Array(12).fill(0))
    expect(
      read()
        .map((t) => t.id)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
  })
})

describe('stale claims', () => {
  it('claim records a timestamp and heartbeat refreshes it', () => {
    seed(task(1))
    cli('claim', 'ux-worker', 'me')
    expect(byId(1).claimedAt).toBeDefined()
    expect(byId(1).heartbeatAt).toBeUndefined()
    cli('heartbeat', '1', '--owner', 'me')
    expect(byId(1).heartbeatAt).toBeDefined()
    expect(cli('heartbeat', '1', '--owner', 'nobody').status).toBe(1)
  })

  it('stale reports quiet claims and flags the ones with no timestamp', () => {
    seed(
      task(1, { status: 'claimed', owner: 'old', claimedAt: hoursAgo(48) }),
      task(2, { status: 'claimed', owner: 'beating', claimedAt: hoursAgo(48), heartbeatAt: hoursAgo(1) }),
      task(3, { status: 'claimed', owner: 'legacy' }),
    )
    const stale = cli('stale').json
    expect(stale.map((claim: { id: number }) => claim.id)).toEqual([1, 3])
    expect(stale[0].ageHours).toBeGreaterThanOrEqual(47)
    expect(stale[1].ageHours).toBeNull()
  })

  it('reap needs an explicit age, reopens timed-out claims, and spares untimed ones unless asked', () => {
    seed(
      task(1, { status: 'claimed', owner: 'old', claimedAt: hoursAgo(48) }),
      task(2, { status: 'claimed', owner: 'legacy' }),
      task(3, { status: 'claimed', owner: 'fresh', claimedAt: hoursAgo(1) }),
    )
    expect(cli('reap').status).toBe(1)
    expect(cli('reap', '--older-than', '24').json.map((t: Task) => t.id)).toEqual([1])
    expect(byId(1)).toMatchObject({ status: 'open', owner: null })
    expect(byId(1).claimedAt).toBeUndefined()
    expect(byId(2).status).toBe('claimed')
    expect(byId(3).status).toBe('claimed')
    expect(cli('reap', '--older-than', '24', '--include-untimed').json.map((t: Task) => t.id)).toEqual([2])
    expect(byId(3).status).toBe('claimed')
  })
})

describe('after', () => {
  it('re-plans a task blocked by a cancelled dependency', () => {
    seed(task(1, { status: 'cancelled' }), task(2, { status: 'done' }), task(3, { after: [1] }))
    expect(cli('claim', 'ux-worker', 'me').json).toBeNull()
    expect(cli('after', '3', '2').json.after).toEqual([2])
    expect(cli('claim', 'ux-worker', 'me').json.id).toBe(3)
  })

  it('refuses unknown ids, self-dependency, cycles, and non-open tasks', () => {
    seed(task(1), task(2, { after: [1] }), task(3, { status: 'claimed', owner: 'x' }))
    expect(cli('after', '1', '99').status).toBe(1)
    expect(cli('after', '1', '1').status).toBe(1)
    const cycle = cli('after', '1', '2')
    expect(cycle.status).toBe(1)
    expect(cycle.stderr).toContain('cycle')
    expect(byId(1).after).toEqual([])
    expect(cli('after', '3', 'none').status).toBe(1)
  })
})

describe('doctor', () => {
  it('is quiet on a healthy board and exits 0', () => {
    seed(task(1, { status: 'done' }), task(2, { after: [1] }))
    cli('lead-wake', 'thread:lead', '--by', 'lead')
    const report = cli('doctor')
    expect(report.status).toBe(0)
    expect(report.json.ok).toBe(true)
    expect(report.json.findings.filter((f: { level: string }) => f.level !== 'info')).toEqual([])
  })

  it('reports blocked dependencies and unowned claims, and --fix repairs only the unowned claim', () => {
    seed(task(1, { status: 'cancelled' }), task(2, { after: [1] }), task(3, { status: 'claimed', owner: null }))
    const before = cli('doctor')
    expect(before.status).toBe(1)
    const codes = before.json.findings.map((f: { code: string }) => f.code)
    expect(codes).toContain('blocked-by-cancelled')
    expect(codes).toContain('claimed-no-owner')

    const after = cli('doctor', '--fix')
    expect(after.status).toBe(0)
    expect(after.stderr).toContain('reopened claimed task(s) that had no owner: 3')
    expect(byId(3).status).toBe('open')
    expect(byId(2).after).toEqual([1])
    expect(after.json.findings.map((f: { code: string }) => f.code)).toContain('blocked-by-cancelled')
  })

  it('--fix restores a corrupt board that has a backup', () => {
    seed(task(1))
    cli('add', 'ux-worker', 'second')
    writeFileSync(board, '')
    expect(cli('doctor').status).toBe(1)
    const fixed = cli('doctor', '--fix')
    expect(fixed.status).toBe(0)
    expect(read().map((t) => t.id)).toEqual([1, 2])
  })

  it('reports claims of unknown age as information, never as an error', () => {
    seed(task(1, { status: 'claimed', owner: 'legacy' }))
    const report = cli('doctor')
    expect(report.status).toBe(0)
    expect(report.json.findings).toContainEqual(expect.objectContaining({ level: 'info', code: 'untimed-claims' }))
  })
})

const verdict = (over: Partial<JevVerdict> = {}): JevVerdict => ({
  route: 'haiku_fork',
  jevRoute: 'haiku_fork',
  confidence: 0.9,
  holds: [],
  roleFits: true,
  suggestedRole: null,
  check: 'focused_test',
  reasons: ['ok'],
  ...over,
})

const findingCodes = (report: { json: { findings: { code: string }[] } }) =>
  report.json.findings.map((finding) => finding.code)

describe('route vocabulary', () => {
  it('accepts Terra verdicts and dispatch while preserving Sol records', () => {
    seed(task(1, { route: 'sol_patch', jev: verdict({ route: 'sol_patch', jevRoute: 'sol_patch' }) }))
    expect(findingCodes(cli('doctor'))).not.toContain('unknown-route')
    const routed = cli('jev', '1', JSON.stringify(verdict({ route: 'terra_patch', jevRoute: 'terra_patch' })))
    expect(routed.status).toBe(0)
    expect(routed.json.route).toBe('terra_patch')
    expect(cli('claim', 'ux-worker', 'terra-worker', '--id', '1').json).toMatchObject({
      route: 'terra_patch',
      owner: 'terra-worker',
      status: 'claimed',
    })
    expect(cli('add', 'ux-worker', 'Terra task', '--route', 'terra_patch').json.route).toBe('terra_patch')
    expect(cli('add', 'ux-worker', 'Sol task', '--route', 'sol_patch').json.route).toBe('sol_patch')
    expect(findingCodes(cli('doctor'))).not.toContain('unknown-route')
  })

  it('KNOWN_ROUTES includes Jev and board-only routes without duplicates', () => {
    expect(ROUTES.length).toBeGreaterThan(0)
    expect([...JEV_HOLDS]).toEqual([...HOLDS])
    expect([...JEV_CHECKS]).toEqual(Object.keys(CHECKS))
    expect(KNOWN_ROUTES).toEqual([
      ...ROUTES,
      'lead_workflow',
      'claude_patch',
      'claude_review',
      'claude_audit',
      'claude_design',
      'gemini_review',
      'gemini_audit',
      'gemini_design',
      'codex_patch',
      'codex_review',
      'codex_audit',
      'codex_design',
    ])
    expect(new Set(KNOWN_ROUTES).size).toBe(KNOWN_ROUTES.length)
    for (const route of ['codex_patch', 'codex_review', 'codex_audit', 'codex_design']) {
      expect(cli('add', 'ux-worker', route, '--route', route).json.route).toBe(route)
    }
    expect(findingCodes(cli('doctor'))).not.toContain('unknown-route')
  })

  it('refuses an unknown route and names the known ones', () => {
    seed(task(1))
    const before = readFileSync(board, 'utf8')
    for (const result of [
      cli('add', 'ux-worker', 'nope', '--route', 'opus_session'),
      cli('route', '1', 'opus_session'),
    ]) {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('unknown route')
      expect(result.stderr).toContain('haiku_fork')
      expect(result.stderr).toContain('lead_workflow')
    }
    const verdictRoute = cli('jev', '1', JSON.stringify(verdict({ route: 'opus_session' })))
    expect(verdictRoute.status).toBe(1)
    expect(verdictRoute.stderr).toContain('unknown route')
    expect(verdictRoute.stderr).toContain('haiku_fork')
    expect(verdictRoute.stderr).not.toContain('lead_workflow')
    expect(readFileSync(board, 'utf8')).toBe(before)
    expect(cli('add', 'lead', 'Run it here', '--route', 'lead_workflow').json.route).toBe('lead_workflow')
  })

  it('a plain claim skips lead_workflow, and claim --id may take it', () => {
    seed(task(1, { route: 'lead_workflow', title: 'lead runs it' }), task(2, { title: 'worker' }))
    expect(cli('claim', 'ux-worker', 'worker').json.id).toBe(2)
    expect(byId(1).status).toBe('open')
    seed(task(1, { route: 'lead_workflow' }))
    expect(cli('claim', 'ux-worker', 'me').json).toBeNull()
    expect(cli('claim', 'ux-worker', 'lead', '--id', '1', '--run', 'workflow:run-9').json).toMatchObject({
      id: 1,
      status: 'claimed',
      run: { kind: 'workflow', ref: 'run-9' },
    })
  })
})

describe('jev verdicts', () => {
  it('add --jev stores a server-stamped verdict, and jev does not lift a hold', () => {
    const added = cli('add', 'ux-worker', 'Fix the label', '--jev', JSON.stringify(verdict({ confidence: 0.8 })))
    expect(added.status).toBe(0)
    expect(added.json).toMatchObject({
      route: 'haiku_fork',
      jev: { route: 'haiku_fork', confidence: 0.8, check: 'focused_test' },
    })
    expect(added.json.jev.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(added.json.note).toBeUndefined()

    seed(task(1, { route: 'needs_lead' }))
    const attached = cli(
      'jev',
      '1',
      JSON.stringify(verdict({ route: 'needs_lead', at: '2026-01-02T03:04:05.000Z', holds: ['risky'] })),
    )
    expect(attached.status).toBe(0)
    expect(attached.json.route).toBe('needs_lead')
    expect(attached.json.jev.at).not.toBe('2026-01-02T03:04:05.000Z')
    expect(attached.json.jev.holds).toEqual(['risky'])
    expect(attached.json.note).toContain('only `route <id> <route> --reason` can leave needs_lead')
    expect(byId(1).route).toBe('needs_lead')
    expect(byId(1)).not.toHaveProperty('note')
    expect(cli('jev', '1', JSON.stringify(verdict({ holds: ['risky'] }))).stderr).toContain(
      'holds require route needs_lead',
    )
  })

  it('requires --reason when an explicit --route differs from the verdict', () => {
    const refused = cli(
      'add',
      'ux-worker',
      'Fix the label',
      '--route',
      'sonnet_patch',
      '--jev',
      JSON.stringify(verdict()),
    )
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('--reason')
    const added = cli(
      'add',
      'ux-worker',
      'Fix the label',
      '--route',
      'sonnet_patch',
      '--jev',
      JSON.stringify(verdict()),
      '--reason',
      '  wider than the fork  ',
      '--by',
      'lead',
    )
    expect(added.status).toBe(0)
    expect(added.json.route).toBe('sonnet_patch')
    expect(added.json.jev.route).toBe('haiku_fork')
    expect(added.json.decisions[0]).toMatchObject({
      kind: 'route',
      from: 'haiku_fork',
      to: 'sonnet_patch',
      reason: 'wider than the fork',
      by: 'lead',
    })
    expect(findingCodes(cli('doctor'))).not.toContain('undocumented-override')
  })

  // Split in three: all eleven CLI spawns in one test ran past the 5s limit on the CI runner.
  it('rejects a malformed jev command before it stores a verdict', () => {
    seed(task(1, { status: 'claimed', owner: 'me', route: 'haiku_fork' }))
    const before = readFileSync(board, 'utf8')
    expect(cli('jev', '1').stderr).toContain('usage: jev')
    expect(cli('jev', '1', '{').stderr).toContain('not valid JSON')
    expect(cli('jev', '1', '[]').stderr).toContain('must be an object')
    expect(cli('jev', '1', 'null').stderr).toContain('must be an object')
    expect(cli('jev', '1', '"x"').stderr).toContain('must be an object')
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('rejects a garbage verdict on add before it stores one', () => {
    seed(task(1, { status: 'claimed', owner: 'me', route: 'haiku_fork' }))
    const before = readFileSync(board, 'utf8')
    expect(cli('add', 'ux-worker', 't', '--jev', JSON.stringify(verdict({ confidence: 1.2 }))).status).toBe(1)
    expect(
      cli('add', 'ux-worker', 't', '--jev', JSON.stringify(verdict({ jevRoute: 'lead_workflow' }))).stderr,
    ).toContain('jevRoute')
    expect(cli('add', 'ux-worker', 't', '--jev', JSON.stringify(verdict({ holds: ['maybe'] }))).status).toBe(1)
    expect(cli('add', 'ux-worker', 't', '--jev', JSON.stringify(verdict({ check: 'banana' }))).status).toBe(1)
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('stores a verdict on a task that is not open', () => {
    seed(task(1, { status: 'claimed', owner: 'me', route: 'haiku_fork' }))
    const stored = cli('jev', '1', JSON.stringify(verdict({ at: '1' })))
    expect(stored.status).toBe(0)
    expect(stored.json.route).toBe('haiku_fork')
    expect(stored.json.jev.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stored.json.note).toContain('task is claimed')
    expect(byId(1).jev?.at).toBe(stored.json.jev.at)
  })

  it('still adds a legacy task with no verdict', () => {
    seed(task(1, { status: 'done' }))
    expect(cli('add', 'qa-worker', 'Verify the fix', '--after', '1').json).toEqual({
      id: 2,
      role: 'qa-worker',
      title: 'Verify the fix',
      status: 'open',
      owner: null,
      after: [1],
      route: null,
      accept: ACCEPT,
    })
  })
})

describe('decisions', () => {
  it('requires a reason to leave needs_lead or to override Jev, and records the decision', () => {
    seed(task(1, { route: 'needs_lead' }), task(2, { route: 'haiku_fork', jev: verdict() }))
    const heldBefore = readFileSync(board, 'utf8')
    const held = cli('route', '1', 'grok_patch')
    expect(held.status).toBe(1)
    expect(held.stderr).toContain('--reason')
    expect(readFileSync(board, 'utf8')).toBe(heldBefore)
    expect(cli('route', '1', 'grok_patch', '--reason', 'behavior is specified', '--by', 'lead').json.route).toBe(
      'grok_patch',
    )
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'route',
      from: 'needs_lead',
      to: 'grok_patch',
      reason: 'behavior is specified',
      by: 'lead',
    })

    expect(cli('route', '2', 'sonnet_patch').status).toBe(1)
    expect(cli('route', '2', 'sonnet_patch', '--reason', 'wider than it looked').status).toBe(0)
    expect(findingCodes(cli('doctor'))).not.toContain('undocumented-override')
  })

  it('allows a route change with no reason when it is not a hold and not an override', () => {
    seed(task(1, { route: 'luna_patch', jev: verdict({ route: 'sol_patch', jevRoute: 'sol_patch' }) }))
    expect(cli('route', '1', 'sol_patch').status).toBe(0)
    expect(byId(1).decisions?.[0]).toMatchObject({ from: 'luna_patch', to: 'sol_patch', reason: null, by: null })
    seed(task(1, { route: 'haiku_fork' }))
    expect(cli('route', '1', 'luna_patch', '--reason', ' ').status).toBe(1)
    expect(byId(1).route).toBe('haiku_fork')
    expect(cli('route', '1', 'luna_patch').status).toBe(0)
  })

  it('warns only when an open or claimed route differs from the verdict and no decision explains it', () => {
    seed(
      task(1, { route: 'needs_lead', jev: verdict({ route: 'needs_lead', jevRoute: 'haiku_fork', holds: ['risky'] }) }),
      task(2, {
        route: 'sol_patch',
        jev: verdict(),
        decisions: [
          {
            at: '2020-01-01T00:00:00.000Z',
            kind: 'route',
            from: 'haiku_fork',
            to: 'luna_patch',
            reason: 'old',
            by: null,
          },
        ],
      }),
      task(3, { status: 'done', route: 'sol_patch', jev: verdict() }),
    )
    const overrides = cli('doctor').json.findings.filter(
      (finding: { code: string }) => finding.code === 'undocumented-override',
    )
    expect(overrides.map((finding: { id: number }) => finding.id)).toEqual([2])
    expect(cli('route', '1', 'needs_lead', '--reason', 'still held: migration').status).toBe(0)
    expect(cli('route', '2', 'sol_patch', '--reason', 'kept the wider route').status).toBe(0)
    expect(findingCodes(cli('doctor'))).not.toContain('undocumented-override')
  })

  it('records an option decision on any task that is not cancelled', () => {
    seed(
      task(1),
      task(2, { status: 'done' }),
      task(3, { status: 'cancelled' }),
      task(4, { status: 'claimed', owner: 'me' }),
    )
    const before = readFileSync(board, 'utf8')
    expect(cli('decide', '3', '--summary', 'no').status).toBe(1)
    expect(cli('decide', '1').status).toBe(1)
    expect(readFileSync(board, 'utf8')).toBe(before)
    expect(cli('decide', '1', '--summary', 'ship fix A', '--ref', 'tmp/choice.json', '--by', 'lead').status).toBe(0)
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'choice',
      summary: 'ship fix A',
      ref: 'tmp/choice.json',
      by: 'lead',
    })
    expect(cli('decide', '2', '--summary', 'after the fact').status).toBe(0)
    expect(cli('decide', '4', '--summary', 'while claimed').status).toBe(0)
  })

  it('warns when Jev says the role does not fit', () => {
    seed(
      task(1, { jev: verdict({ roleFits: false, suggestedRole: 'backend-worker' }) }),
      task(2, { jev: verdict({ roleFits: false, suggestedRole: 'ux-worker' }) }),
      task(3, { jev: verdict({ roleFits: true, suggestedRole: 'backend-worker' }) }),
      task(4, { jev: verdict({ roleFits: false, suggestedRole: null }) }),
      task(5, { status: 'done', jev: verdict({ roleFits: false, suggestedRole: 'backend-worker' }) }),
    )
    const mismatches = cli('doctor').json.findings.filter(
      (finding: { code: string }) => finding.code === 'role-mismatch',
    )
    expect(mismatches.map((finding: { id: number; message: string }) => finding.message)).toEqual([
      'task 1 role ux-worker does not fit. Jev suggested backend-worker.',
      'task 4 role ux-worker does not fit. Jev did not suggest one.',
    ])
    // Task 2 already has the role Jev suggested (jev-route --add adopted it), so it is not flagged.
    expect(mismatches.every((finding: { message: string }) => !finding.message.includes('does not match'))).toBe(true)
    const fixed = cli('doctor', '--fix')
    expect(fixed.json.findings.filter((finding: { code: string }) => finding.code === 'role-mismatch')).toHaveLength(2)
    expect(byId(1).route).toBe('sonnet_patch')
  })

  it('requires a reason when a lead route decision holds, including a return to the verdict route', () => {
    seed(task(1, { route: 'luna_patch', jev: verdict({ route: 'sol_patch', jevRoute: 'sol_patch' }) }))
    expect(cli('route', '1', 'grok_patch', '--reason', 'lead holds this', '--by', 'lead').status).toBe(0)
    const before = readFileSync(board, 'utf8')
    const back = cli('route', '1', 'sol_patch')
    expect(back.status).toBe(1)
    expect(back.stderr).toContain('--reason')
    expect(back.stderr).toContain('a lead route decision holds the current route')
    expect(back.stderr).not.toContain('healed:')
    const elsewhere = cli('route', '1', 'haiku_fork')
    expect(elsewhere.status).toBe(1)
    expect(elsewhere.stderr).toContain('a lead route decision holds the current route')
    expect(elsewhere.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(before)
    expect(cli('route', '1', 'sol_patch', '--reason', 'back to the verdict').status).toBe(0)
    expect(byId(1).route).toBe('sol_patch')
    expect(byId(1).decisions?.at(-1)).toMatchObject({ to: 'sol_patch', reason: 'back to the verdict' })

    seed(
      task(1, {
        route: 'grok_patch',
        claimedAt: hoursAgo(1),
        jev: verdict({ route: 'sol_patch', jevRoute: 'sol_patch' }),
        decisions: [
          {
            at: '2026-01-01T00:00:00.000Z',
            kind: 'route',
            from: 'luna_patch',
            to: 'grok_patch',
            reason: 'lead holds this',
            by: 'lead',
          },
        ],
      }),
    )
    const dirty = readFileSync(board, 'utf8')
    const refused = cli('route', '1', 'sol_patch')
    expect(refused.status).toBe(1)
    expect(refused.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(dirty)

    seed(
      task(1, {
        route: 'grok_patch',
        jev: verdict({ route: 'grok_patch', jevRoute: 'grok_patch', at: '2020-01-01T00:00:00.000Z' }),
        decisions: [
          {
            at: '2026-01-01T00:00:00.000Z',
            kind: 'route',
            from: 'luna_patch',
            to: 'grok_patch',
            reason: 'lead holds this',
            by: 'lead',
          },
        ],
      }),
    )
    expect(cli('route', '1', 'grok_patch').status).toBe(0)
  })

  const reservedJevAttempts: [string, string[]][] = [
    ['route --by jev', ['route', '1', 'luna_patch', '--reason', 'no', '--by', 'jev']],
    ['route --by padded jev', ['route', '1', 'luna_patch', '--reason', 'no', '--by', ' jev ']],
    [
      'add with route --by jev',
      ['add', 'ux-worker', 'Spoof', '--route', 'luna_patch', '--reason', 'no', '--by', 'jev'],
    ],
    ['add --by padded jev', ['add', 'ux-worker', 'Spoof', '--reason', 'no', '--by', ' jev ']],
    ['decide --by jev', ['decide', '1', '--summary', 'no', '--by', 'jev']],
    ['decide --by padded jev', ['decide', '1', '--summary', 'no', '--by', ' jev ']],
    ['route --by JEV', ['route', '1', 'luna_patch', '--reason', 'no', '--by', 'JEV']],
    ['decide --by Jev', ['decide', '1', '--summary', 'no', '--by', 'Jev']],
    ['decide --by zero-width space', ['decide', '1', '--summary', 'no', '--by', `je${String.fromCodePoint(0x200b)}v`]],
    [
      'decide --by left-to-right mark',
      ['decide', '1', '--summary', 'no', '--by', `jev${String.fromCodePoint(0x200e)}`],
    ],
    ['decide --by soft hyphen', ['decide', '1', '--summary', 'no', '--by', `je${String.fromCodePoint(0xad)}v`]],
    [
      'decide --by variation selector',
      ['decide', '1', '--summary', 'no', '--by', `jev${String.fromCodePoint(0xfe0f)}`],
    ],
    [
      'decide --by fullwidth jev',
      ['decide', '1', '--summary', 'no', '--by', String.fromCodePoint(0xff4a, 0xff45, 0xff56)],
    ],
  ]

  // One spawn per test: thirteen sequential spawns in one test ran ~4s on the CI runner, near the 5s limit.
  it.each(reservedJevAttempts)('reserves --by jev: %s', (_name, args) => {
    seed(task(1, { route: 'haiku_fork', claimedAt: hoursAgo(1) }))
    const before = readFileSync(board, 'utf8')
    const result = cli(...args)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('by jev is reserved for verdicts')
    expect(result.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('only a real verdict decision counts as Jev-made', () => {
    seed(task(1, { route: 'haiku_fork', claimedAt: hoursAgo(1) }))
    expect(cli('decide', '1', '--summary', 'kept', '--by', 'jevan').status).toBe(0)
    expect(byId(1).decisions?.at(-1)).toMatchObject({ kind: 'choice', by: 'jevan' })

    seed(
      task(1, {
        route: 'grok_patch',
        jev: verdict({ route: 'haiku_fork', at: '2020-01-01T00:00:00.000Z' }),
        decisions: [
          {
            at: '2026-01-01T00:00:00.000Z',
            kind: 'route',
            from: 'haiku_fork',
            to: 'grok_patch',
            reason: 'jev verdict',
            by: 'jev',
          },
        ],
      }),
    )
    const held = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(held.status).toBe(0)
    expect(held.json.route).toBe('grok_patch')
    expect(held.json.note).toContain('only `route <id> <route> --reason` changes it')

    seed(
      task(1, {
        route: 'sol_patch',
        jev: verdict({ route: 'sol_patch', jevRoute: 'sol_patch', at: '2026-02-01T00:00:00.000Z' }),
        decisions: [
          {
            at: '2026-02-01T00:00:00.000Z',
            kind: 'route',
            from: null,
            to: 'sol_patch',
            reason: 'jev verdict',
            by: 'jev',
            verdict: null,
          },
        ],
      }),
    )
    const moved = cli('jev', '1', JSON.stringify(verdict({ route: 'luna_patch', jevRoute: 'luna_patch' })))
    expect(moved.status).toBe(0)
    expect(moved.json.route).toBe('luna_patch')
    expect(moved.json.note).toBeUndefined()
  })

  it('refuses add --reason without --route, add --by with nothing journaled, and blank decide text', () => {
    seed(task(1, { claimedAt: hoursAgo(1) }))
    const before = readFileSync(board, 'utf8')
    const reasonOnly = cli('add', 'ux-worker', 'No route', '--reason', 'because')
    const whitespaceReason = cli('add', 'ux-worker', 'Blank', '--reason', '   ')
    const byOnly = cli('add', 'ux-worker', 'By only', '--by', 'lead')
    const byRoute = cli('add', 'ux-worker', 'By route', '--route', 'luna_patch', '--by', 'lead')
    const blankReason = cli(
      'add',
      'ux-worker',
      'Blank reason',
      '--route',
      'luna_patch',
      '--reason',
      '  ',
      '--by',
      'lead',
    )
    expect(reasonOnly.stderr).toContain('add --reason needs --route')
    expect(whitespaceReason.stderr).toContain('add --reason needs --route')
    expect(whitespaceReason.stderr).not.toContain('--reason must not be empty')
    expect(byOnly.stderr).toContain('add --by needs a journaled decision')
    expect(byRoute.stderr).toContain('add --by needs a journaled decision')
    expect(blankReason.stderr).toContain('--reason must not be empty')
    for (const result of [reasonOnly, whitespaceReason, byOnly, byRoute, blankReason]) {
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('healed:')
    }
    expect(readFileSync(board, 'utf8')).toBe(before)

    const journaled = cli(
      'add',
      'ux-worker',
      'Journaled',
      '--route',
      'luna_patch',
      '--reason',
      'picked',
      '--by',
      'lead',
    )
    expect(journaled.status).toBe(0)
    expect(journaled.json.decisions[0].by).toBe('lead')

    seed(task(1, { route: 'haiku_fork' }))
    expect(cli('route', '1', 'luna_patch', '--by', ' lead ').status).toBe(0)
    expect(byId(1).decisions?.[0]?.by).toBe(' lead ')

    seed(task(1, { claimedAt: hoursAgo(1) }))
    const dirty = readFileSync(board, 'utf8')
    const blankRef = cli('decide', '1', '--summary', 'x', '--ref', '   ')
    const blankBy = cli('decide', '1', '--summary', 'x', '--by', '   ')
    expect(blankRef.status).toBe(1)
    expect(blankRef.stderr).toContain('--ref must not be empty')
    expect(blankRef.stderr).not.toContain('healed:')
    expect(blankBy.status).toBe(1)
    expect(blankBy.stderr).toContain('--by must not be empty')
    expect(blankBy.stderr).not.toContain('reserved')
    expect(blankBy.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(dirty)
    const decided = cli('decide', '1', '--summary', 'ship', '--ref', '  tmp/a.json  ', '--by', '  lead  ')
    expect(decided.status).toBe(0)
    expect(byId(1).decisions?.[0]).toMatchObject({ ref: 'tmp/a.json', by: 'lead' })
    expect(cli('decide', '1', '--summary', 'plain').status).toBe(0)
    expect(byId(1).decisions?.[1]).toMatchObject({ ref: null, by: null })
  })

  it('does not warn undocumented-override when a journaled verdict explains the route', () => {
    seed(
      task(1, {
        route: 'needs_lead',
        jev: verdict({ route: 'needs_lead', jevRoute: 'haiku_fork', holds: ['risky'] }),
      }),
    )
    const replaced = cli('jev', '1', JSON.stringify(verdict({ route: 'haiku_fork', jevRoute: 'haiku_fork' })))
    expect(replaced.status).toBe(0)
    expect(replaced.json.route).toBe('needs_lead')
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'jev',
      verdict: expect.objectContaining({ route: 'needs_lead' }),
    })
    expect(findingCodes(cli('doctor'))).not.toContain('undocumented-override')

    seed(task(1, { route: 'haiku_fork', jev: verdict() }))
    expect(cli('claim', 'ux-worker', 'me', '--id', '1').status).toBe(0)
    const stored = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(stored.json.route).toBe('haiku_fork')
    expect(stored.json.note).toContain('task is claimed')
    expect(cli('release', '1').status).toBe(0)
    expect(byId(1)).toMatchObject({ status: 'open', route: 'haiku_fork' })
    expect(byId(1).jev?.route).toBe('sol_patch')
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'jev',
      verdict: expect.objectContaining({ route: 'haiku_fork' }),
    })
    expect(findingCodes(cli('doctor'))).not.toContain('undocumented-override')

    seed(task(1, { route: 'luna_patch', jev: verdict({ route: 'sol_patch', jevRoute: 'sol_patch' }) }))
    expect(findingCodes(cli('doctor'))).toContain('undocumented-override')
  })
})

describe('run links and evidence', () => {
  it('stores a run on claim and heartbeat, and rejects an unknown kind', () => {
    seed(task(1), task(2))
    const before = readFileSync(board, 'utf8')
    const bad = cli('claim', 'ux-worker', 'me', '--run', 'pod:abc')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('known kinds')
    expect(readFileSync(board, 'utf8')).toBe(before)
    const claimed = cli('claim', 'ux-worker', 'me', '--id', '1', '--run', 'session:abc:def')
    expect(claimed.json.run).toEqual({ kind: 'session', ref: 'abc:def', at: claimed.json.claimedAt })
    const refreshed = cli('heartbeat', '1', '--run', 'subagent:child')
    expect(refreshed.json.run).toEqual({ kind: 'subagent', ref: 'child', at: claimed.json.claimedAt })
    expect(byId(1).heartbeatAt).toBeDefined()
    expect(cli('heartbeat', '1').json.run).toEqual({ kind: 'subagent', ref: 'child', at: claimed.json.claimedAt })
    expect(cli('claim', 'ux-worker', 'other', '--id', '2').json.run).toBeUndefined()
    const missing = cli('doctor').json.findings.find(
      (finding: { code: string }) => finding.code === 'claim-without-run',
    )
    expect(missing.message.split(': ').at(-1)).toBe('2')
    expect(cli('heartbeat', '2', '--run', 'session:two').status).toBe(0)
    expect(findingCodes(cli('doctor'))).not.toContain('claim-without-run')
  })

  it('clears the run and claim timestamps on release, cancel, and reap', () => {
    seed(
      task(1, {
        status: 'claimed',
        owner: 'me',
        claimedAt: hoursAgo(1),
        heartbeatAt: hoursAgo(1),
        run: { kind: 'workflow', ref: 'w' },
      }),
      task(2, {
        status: 'claimed',
        owner: 'old',
        claimedAt: hoursAgo(48),
        run: { kind: 't3_task', ref: 't1' },
      }),
    )
    expect(cli('release', '1').stderr).not.toContain('leftover')
    expect(byId(1)).toMatchObject({ status: 'open', owner: null })
    expect(byId(1).run).toBeUndefined()
    expect(byId(1).claimedAt).toBeUndefined()
    expect(byId(1).heartbeatAt).toBeUndefined()
    expect(cli('reap', '--older-than', '24').json.map((item: Task) => item.id)).toEqual([2])
    expect(byId(2).run).toBeUndefined()
    expect(byId(2).claimedAt).toBeUndefined()

    seed(
      task(1, {
        status: 'claimed',
        owner: 'me',
        claimedAt: hoursAgo(1),
        heartbeatAt: hoursAgo(1),
        run: { kind: 'workflow', ref: 'w' },
      }),
    )
    expect(cli('cancel', '1').stderr).not.toContain('leftover')
    expect(byId(1)).toMatchObject({ status: 'cancelled', owner: null })
    expect(byId(1).claimedAt).toBeUndefined()
    expect(byId(1).heartbeatAt).toBeUndefined()
    expect(byId(1).run).toBeUndefined()
  })

  it('includes the current run in stale output and ignores a stale run', () => {
    const claimedAt = hoursAgo(48)
    seed(
      task(1, { status: 'claimed', owner: 'old', claimedAt, run: { kind: 'workflow', ref: 'w1', at: claimedAt } }),
      task(2, {
        status: 'claimed',
        owner: 'older',
        claimedAt: hoursAgo(48),
        run: { kind: 'workflow', ref: 'stale', at: hoursAgo(90) },
      }),
    )
    expect(cli('stale').json.find((claim: { id: number }) => claim.id === 1).run).toEqual({
      kind: 'workflow',
      ref: 'w1',
      at: claimedAt,
    })
    expect(cli('stale').json.find((claim: { id: number }) => claim.id === 2).run).toBeNull()
    const stale = cli('doctor').json.findings.find(
      (finding: { code: string; id?: number }) => finding.code === 'stale-claim' && finding.id === 1,
    )
    expect(stale.message).toContain('workflow:w1')
    expect(stale.message).toContain('release 1')
    const ignored = cli('doctor').json.findings.find(
      (finding: { code: string; id?: number }) => finding.code === 'stale-claim' && finding.id === 2,
    )
    expect(ignored.message).not.toContain('stale')
  })

  it('appends trimmed deduped evidence, including on done, and keeps claim provenance', () => {
    const claimedAt = hoursAgo(1)
    seed(
      task(1, {
        status: 'claimed',
        owner: 'me',
        claimedAt,
        run: { kind: 'session', ref: 's', at: claimedAt },
        evidence: ['docs/a.md'],
      }),
    )
    cli('evidence', '1', '  https://example.test/b  ', 'docs/a.md')
    expect(
      cli('done', '1', '--owner', 'me', '--evidence', 'https://example.test/a,b', '--evidence', '  logs/c.txt  ').json
        .status,
    ).toBe('done')
    expect(byId(1).evidence).toEqual(['docs/a.md', 'https://example.test/b', 'https://example.test/a,b', 'logs/c.txt'])
    expect(byId(1).claimedAt).toBe(claimedAt)
    expect(byId(1).run).toEqual({ kind: 'session', ref: 's', at: claimedAt })
    seed(task(1, { status: 'done', evidence: ['a'] }))
    expect(cli('done', '1', '--evidence', '  b  ').status).toBe(0)
    expect(byId(1).evidence).toEqual(['a', 'b'])
  })
})

describe('journal heals', () => {
  it('drops leftover claim fields and duplicate evidence, and a later fix is a no-op', () => {
    const doneClaimedAt = hoursAgo(3)
    seed(
      task(1, {
        status: 'cancelled',
        claimedAt: hoursAgo(2),
        heartbeatAt: hoursAgo(2),
        run: { kind: 'workflow', ref: 'old' },
        evidence: ['a', 'a', 'b', 'a'],
      }),
      task(2, { status: 'done', claimedAt: doneClaimedAt, evidence: ['x', 'x'] }),
    )
    const before = readFileSync(board, 'utf8')
    const readonly = cli('doctor')
    expect(readonly.status).toBe(0)
    expect(readFileSync(board, 'utf8')).toBe(before)

    const preview = cli('doctor')
    expect(preview.status).toBe(0)
    expect(preview.json.findings).toContainEqual(
      expect.objectContaining({
        level: 'info',
        code: 'claim-residue',
        fixable: true,
        message: expect.stringContaining(': 1'),
      }),
    )
    expect(preview.json.findings).toContainEqual(
      expect.objectContaining({ level: 'info', code: 'duplicate-evidence', fixable: true }),
    )
    expect(
      preview.json.findings.find((finding: { code: string }) => finding.code === 'claim-residue').message,
    ).not.toContain('2')

    const fixed = cli('doctor', '--fix')
    expect(fixed.stderr).toContain('team-tasks: healed: cleared leftover claim fields on task(s): 1')
    expect(fixed.stderr).not.toContain('cleared leftover claim fields on task(s): 1, 2')
    expect(fixed.stderr).toContain('team-tasks: healed: deduped evidence on task(s): 1, 2')
    expect(byId(1).run).toBeUndefined()
    expect(byId(1).claimedAt).toBeUndefined()
    expect(byId(1).heartbeatAt).toBeUndefined()
    expect(byId(1).evidence).toEqual(['a', 'b'])
    expect(byId(2).claimedAt).toBe(doneClaimedAt)
    expect(byId(2).evidence).toEqual(['x'])
    expect(byId(1).status).toBe('cancelled')
    expect(cli('doctor', '--fix').stderr).not.toContain('healed:')
  })

  it('heals during any mutating command and leaves an unknown route and mixed evidence alone', () => {
    seed(task(1, { claimedAt: hoursAgo(1), evidence: ['p', 'p'], route: 'opus_session' }))
    const added = cli('add', 'ux-worker', 'next', '--route', 'haiku_fork')
    expect(added.status).toBe(0)
    expect(added.stderr).toContain('cleared leftover claim fields on task(s): 1')
    expect(added.stderr).toContain('deduped evidence on task(s): 1')
    expect(byId(1).route).toBe('opus_session')
    expect(byId(1).claimedAt).toBeUndefined()
    expect(byId(1).evidence).toEqual(['p'])
    expect(findingCodes(cli('doctor'))).toContain('unknown-route')

    const mixed = task(3, { evidence: ['a', 'a'] })
    ;(mixed as { evidence: unknown[] }).evidence = ['a', 'a', 1]
    seed(mixed)
    const bytes = readFileSync(board, 'utf8')
    expect(cli('doctor', '--fix').status).toBe(0)
    expect(readFileSync(board, 'utf8')).toBe(bytes)
  })

  it('a refused command does not heal and does not change the file', () => {
    seed(task(1, { claimedAt: hoursAgo(1), evidence: ['p', 'p'] }))
    const before = readFileSync(board, 'utf8')
    const refused = cli('done', '1', '--evidence', 'docs/a.md')
    expect(refused.status).toBe(1)
    expect(refused.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('drops a stale run on a claimed task and leaves one on a done task', () => {
    const claimedAt = hoursAgo(2)
    seed(
      task(1, { status: 'claimed', owner: 'me', claimedAt, run: { kind: 'workflow', ref: 'old' } }),
      task(2, { status: 'done', claimedAt, run: { kind: 'workflow', ref: 'kept', at: 'not-this-claim' } }),
    )
    const healed = cli('add', 'qa-worker', 'unrelated')
    expect(healed.stderr).toContain('dropped stale run on task(s): 1')
    expect(healed.stderr).not.toContain('2')
    expect(byId(1).run).toBeUndefined()
    expect(byId(1).claimedAt).toBe(claimedAt)
    expect(byId(2).run).toEqual({ kind: 'workflow', ref: 'kept', at: 'not-this-claim' })
    expect(byId(2).claimedAt).toBe(claimedAt)
  })
})

describe('verdict and evidence edges', () => {
  it('refuses a run with no colon, an empty ref, or a leading colon', () => {
    expect(() => parseRun('workflow')).toThrow(/<kind>:<ref>/)
    expect(() => parseRun(':ref')).toThrow(/<kind>:<ref>/)
    expect(() => parseRun('workflow:')).toThrow(/must not be empty/)
  })

  it('refuses a verdict that is not a consistent object and ignores a caller at', () => {
    const now = new Date('2026-05-01T00:00:00.000Z')
    expect(() => normalizeVerdict([], now)).toThrow(/must be an object/)
    expect(() => normalizeVerdict(null, now)).toThrow(/must be an object/)
    expect(() => normalizeVerdict('"x"', now)).toThrow(/must be an object/)
    expect(() => normalizeVerdict(verdict({ roleFits: 'yes' as unknown as boolean }), now)).toThrow(/roleFits/)
    expect(() => normalizeVerdict(verdict({ suggestedRole: '' }), now)).toThrow(/suggestedRole/)
    expect(() => normalizeVerdict(verdict({ reasons: 'ok' as unknown as string[] }), now)).toThrow(/reasons/)
    const stored = normalizeVerdict(verdict({ at: '1' }), now)
    expect(stored.at).toBe('2026-05-01T00:00:00.000Z')
    expect(normalizeVerdict(verdict({ route: 'needs_lead', holds: ['needs_decision'] }), now).holds).toEqual([
      'needs_decision',
    ])
  })

  it('keeps raw Jev answers on a verdict and refuses malformed or oversized ones', () => {
    const now = new Date('2026-05-01T00:00:00.000Z')
    const answers = { scope: { score: 1, confidence: 0.8 } }
    expect(normalizeVerdict(verdict({ answers } as object), now).answers).toEqual(answers)
    expect(normalizeVerdict(verdict({}), now)).not.toHaveProperty('answers')
    expect(() => normalizeVerdict(verdict({ answers: [] } as object), now)).toThrow(/answers must be an object/)
    const huge = { note: 'x'.repeat(16_001) }
    expect(() => normalizeVerdict(verdict({ answers: huge } as object), now)).toThrow(/answers must be under/)
  })

  it('stores a validated optional executor on a verdict and refuses a malformed one', () => {
    const now = new Date('2026-05-01T00:00:00.000Z')
    const executor = {
      id: 'opencode:opencode/kimi-k3',
      providerInstanceId: 'opencode',
      model: 'opencode/kimi-k3',
      options: {},
      source: 'jev',
    }
    const tierVerdict = (over: object) =>
      verdict({ route: 'sonnet_patch', jevRoute: 'sonnet_patch', ...over } as object)
    expect(normalizeVerdict(tierVerdict({ executor }), now).executor).toEqual(executor)
    expect(normalizeVerdict(verdict({ executor: null } as object), now).executor).toBeNull()
    // Verdicts stored before the field existed stay valid.
    expect(normalizeVerdict(verdict({}), now)).not.toHaveProperty('executor')
    const bad = (over: object, pattern: RegExp) =>
      expect(() => normalizeVerdict(tierVerdict({ executor: { ...executor, ...over } }), now)).toThrow(pattern)
    bad({ extra: 1 }, /invalid executor/)
    bad({ id: '' }, /invalid executor/)
    bad({ model: 7 }, /invalid executor/)
    bad({ source: 'lead' }, /invalid executor/)
    bad({ options: [] }, /invalid executor/)
    bad({ options: { effort: { nested: 1 } } }, /invalid executor/)
    bad({ id: 'codex:gpt-6-luna' }, /does not match the registry/)
    bad({ options: { apiKey: 'sk-test-secret' } }, /does not match the registry/)
    bad({ options: { dangerouslySkipPermissions: true } }, /does not match the registry/)
    const pad = 'p'.repeat(100_000)
    let message = ''
    try {
      normalizeVerdict(verdict({ executor: { ...executor, options: { blob: pad } } } as object), now)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/does not match the registry/)
    expect(message.length).toBeLessThan(400)
    expect(message).not.toContain(pad)
    expect(message).not.toContain('sk-test')
    expect(() => normalizeVerdict(verdict({ executor: 'codex' } as object), now)).toThrow(/invalid executor/)
    expect(() => normalizeVerdict(verdict({ executor } as object), now)).toThrow(/not in the route tier/)
    expect(() =>
      normalizeVerdict(
        verdict({
          route: 'needs_lead',
          holds: ['risky'],
          executor: { ...executor, options: { effort: 'high', fast: false } },
        } as object),
        now,
      ),
    ).toThrow(/needs_lead verdict has no executor/)
    expect(() => normalizeVerdict(verdict({ executor, answers: { note: 'x'.repeat(16_001) } } as object), now)).toThrow(
      /answers must be under/,
    )
  })

  it('stores the executor through the jev command', () => {
    seed(task(1, { route: null }))
    const executor = {
      id: 'codex:gpt-6-luna',
      providerInstanceId: 'codex',
      model: 'gpt-6-luna',
      options: { reasoningEffort: 'medium' },
      source: 'default',
    }
    expect(
      cli('jev', '1', JSON.stringify(verdict({ executor, route: 'luna_patch', jevRoute: 'luna_patch' } as object)))
        .status,
    ).toBe(0)
    expect(byId(1).jev).toMatchObject({ executor })
  })

  it('journals a replaced verdict without its raw answers', () => {
    const answers = { scope: { score: 1, confidence: 0.8 } }
    seed(task(1, { route: 'haiku_fork', jev: verdict({ answers } as object) }))
    const replaced = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch', answers })))
    expect(replaced.status).toBe(0)
    const journaled = byId(1).decisions?.filter((entry: { verdict?: object }) => entry.verdict) ?? []
    expect(journaled.length).toBeGreaterThan(0)
    for (const entry of journaled) expect(entry.verdict).not.toHaveProperty('answers')
    expect(byId(1).jev?.answers).toEqual(answers)
  })

  it('names a flag the command does not take, with that command usage, and changes nothing', () => {
    seed(task(1, { status: 'claimed', owner: 'w1' }))
    const before = readFileSync(board, 'utf8')
    const evidence = cli('evidence', '1', '--by', 'w1', 'docs/a.md')
    expect(evidence.status).toBe(1)
    expect(evidence.stderr).toContain('evidence takes no --by')
    expect(evidence.stderr).toContain('usage: evidence <id> [--supporting] <item...>')
    const decide = cli('decide', '1', '--summary', 'why', '--owner', 'w1')
    expect(decide.stderr).toContain('decide takes no --owner')
    expect(decide.stderr).toContain('usage: decide <id> --summary <text>')
    expect(cli('note', '1', 'hello', '--owner', 'o', '--by', 'owner').stderr).toContain('note takes no --owner')
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('lists every command and every flag its handler reads in FLAGS', () => {
    const source = readFileSync(CLI, 'utf8')
    const commands = source.slice(source.indexOf('const COMMANDS = {'))
    const flags = source.slice(source.indexOf('const FLAGS = {'), source.indexOf('const FLAG_SHAPE'))
    const keys = (text: string, shape: RegExp) => [...new Set([...text.matchAll(shape)].map((match) => match[1]))].sort()
    // A FLAGS key line: "  'lead-wake': [" matches; "  add(file, args) {" does not.
    const flagKey = /^ {2}'?([a-z-]+)'?: \[/gm
    // A COMMANDS key line: "  add(", "  async doctor(" and "  inbox: " match; "    const by" does not.
    const commandKey = /^ {2}(?:async )?'?([a-z-]+)'?(?:\(|: )/gm
    // A literal flag read: "takeFlag(args, '--by')" matches; "takeFlag(args, name)" does not.
    const flagRead = /take(?:Flag|Switch|AllFlags)\(args, '(--[a-z-]+)'\)/g
    expect(keys(flags, flagKey)).toEqual(keys(commands, commandKey))
    expect(keys(commands, flagRead).filter((flag) => !flags.includes(`'${flag}'`))).toEqual([])
  })

  it('keeps dashes inside free text', () => {
    seed(task(1, { status: 'claimed', owner: 'w1' }))
    expect(cli('ask-owner', '1', 'Ship', '--', 'or', 'wait?', '--by', 'w1').status).toBe(0)
  })

  it('refuses bad evidence, allows it on done, and trims new items', () => {
    seed(task(1, { evidence: ['docs/a.md'] }))
    expect(cli('evidence', '1').status).toBe(1)
    expect(cli('evidence', '1', '   ').stderr).toContain('non-empty')
    expect(cli('evidence', '1', '--owner').stderr).toContain('evidence takes no --owner')
    expect(cli('evidence', '1', '  docs/b.md  ').status).toBe(0)
    expect(byId(1).evidence).toEqual(['docs/a.md', 'docs/b.md'])

    const odd = task(2, { evidence: ['a'] })
    ;(odd as { evidence: unknown }).evidence = { path: 'a' }
    const mixed = task(3, { evidence: ['a'] })
    ;(mixed as { evidence: unknown[] }).evidence = ['a', 1]
    const cancelled = task(4, { status: 'cancelled' })
    seed(task(1, { status: 'done', evidence: [' kept ', 'docs/a.md'] }), odd, mixed, cancelled)
    expect(cli('evidence', '2', 'b').stderr).toContain('not a list')
    expect(cli('evidence', '3', 'b').stderr).toContain('not all strings')
    expect(cli('evidence', '4', 'b').stderr).toContain('cancelled')
    expect(cli('evidence', '1', '  docs/a.md  ', '  c  ').status).toBe(0)
    expect(byId(1).evidence).toEqual([' kept ', 'docs/a.md', 'c'])
  })

  it('does not write when done --evidence is used on an unclaimed task', () => {
    seed(task(1, { claimedAt: hoursAgo(1) }))
    const before = readFileSync(board, 'utf8')
    const refused = cli('done', '1', '--evidence', 'docs/a.md')
    expect(refused.status).toBe(1)
    expect(refused.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('routes only an open task, and jev moves the route only from the previous verdict', () => {
    seed(task(1, { status: 'claimed', owner: 'me' }), task(2, { status: 'done' }), task(3, { status: 'cancelled' }))
    for (const id of ['1', '2', '3']) expect(cli('route', id, 'luna_patch').stderr).toContain('only an open task')
    seed(task(1, { route: 'haiku_fork', jev: verdict() }))
    const moved = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(moved.status).toBe(0)
    expect(moved.json.note).toBeUndefined()
    expect(moved.json.route).toBe('sol_patch')
    expect(byId(1).decisions?.map((decision) => decision.kind)).toEqual(['jev', 'route'])
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'jev',
      verdict: expect.objectContaining({ route: 'haiku_fork' }),
    })
    expect(byId(1).decisions?.[1]).toMatchObject({
      kind: 'route',
      from: 'haiku_fork',
      to: 'sol_patch',
      reason: 'jev verdict',
      by: 'jev',
      verdict: expect.objectContaining({ route: 'haiku_fork' }),
    })
    expect(byId(1)).not.toHaveProperty('note')
    const again = cli('jev', '1', JSON.stringify(verdict({ route: 'luna_patch', jevRoute: 'luna_patch' })))
    expect(again.json.route).toBe('luna_patch')
    seed(task(1, { route: 'luna_patch' }))
    const held = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(held.json.route).toBe('luna_patch')
    expect(held.json.note).toContain('not the previous verdict route')
    expect(findingCodes(cli('doctor'))).toContain('undocumented-override')
  })

  it('warns about unknown routes only on open and claimed tasks', () => {
    seed(
      task(1, { route: 'lead' }),
      task(2, { status: 'claimed', owner: 'me', route: 'sonnet' }),
      task(3, { status: 'done', route: 'sonnet_subagent' }),
      task(4, { status: 'cancelled', route: '' }),
    )
    const unknown = cli('doctor').json.findings.filter((finding: { code: string }) => finding.code === 'unknown-route')
    expect(unknown.map((finding: { id: number }) => finding.id)).toEqual([1, 2])
    expect(cli('route', '1', 'lead').status).toBe(1)
    expect(cli('route', '1', 'sonnet').status).toBe(1)
    expect(cli('add', 'ux-worker', 'no', '--route', '').status).toBe(1)
    expect(
      cli('doctor', '--fix').json.findings.some((finding: { code: string }) => finding.code === 'unknown-route'),
    ).toBe(true)
  })

  it('keeps a lead route through two later verdicts, and refuses a verdict route jev cannot emit', () => {
    seed(task(1, { route: 'haiku_fork', jev: verdict({ at: '2020-01-01T00:00:00.000Z' }) }))
    expect(cli('route', '1', 'grok_patch', '--reason', 'lead override', '--by', 'lead').status).toBe(0)
    const first = cli('jev', '1', JSON.stringify(verdict({ route: 'grok_patch', jevRoute: 'grok_patch' })))
    expect(first.status).toBe(0)
    expect(first.json.route).toBe('grok_patch')
    expect(first.json.note).toContain('only `route <id> <route> --reason` changes it')
    expect(byId(1)).not.toHaveProperty('note')
    const second = cli('jev', '1', JSON.stringify(verdict({ route: 'haiku_fork' })))
    expect(second.status).toBe(0)
    expect(second.json.route).toBe('grok_patch')
    expect(second.json.note).toContain('only `route <id> <route> --reason` changes it')
    expect(byId(1).route).toBe('grok_patch')
    expect(byId(1).jev?.route).toBe('haiku_fork')
    expect(byId(1).decisions?.filter((decision) => decision.kind === 'jev')).toHaveLength(2)
    expect(byId(1).decisions?.filter((decision) => decision.kind === 'route' && decision.by === 'jev')).toEqual([])

    const before = readFileSync(board, 'utf8')
    const refused = cli('jev', '1', JSON.stringify(verdict({ route: 'lead_workflow' })))
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('lead_workflow')
    expect(cli('jev', '1', JSON.stringify(verdict({ route: 'codex_patch' }))).status).toBe(1)
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('journals every replaced verdict and refuses jev on done and cancelled tasks', () => {
    seed(task(1, { status: 'claimed', owner: 'me', route: 'haiku_fork' }))
    expect(cli('jev', '1', JSON.stringify(verdict())).status).toBe(0)
    expect(byId(1).decisions).toBeUndefined()
    const replaced = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(replaced.json.route).toBe('haiku_fork')
    expect(replaced.json.note).toContain('task is claimed')
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'jev',
      verdict: expect.objectContaining({ route: 'haiku_fork' }),
    })
    expect(byId(1).jev?.route).toBe('sol_patch')

    const previous = verdict({ at: '2020-01-01T00:00:00.000Z' })
    seed(
      task(1, { status: 'done', jev: previous, route: 'haiku_fork' }),
      task(2, { status: 'cancelled', jev: previous }),
    )
    const before = readFileSync(board, 'utf8')
    expect(cli('jev', '1', '{').stderr).toContain('not valid JSON')
    for (const id of ['1', '2']) {
      const refused = cli('jev', id, JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('cannot take a verdict')
      expect(refused.stderr).not.toContain('healed:')
    }
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('treats a non-string run at as stale and refuses heartbeat --run without claimedAt', () => {
    const claimedAt = hoursAgo(1)
    const odd = task(1, {
      status: 'claimed',
      owner: 'me',
      claimedAt,
      run: { kind: 'workflow', ref: 'w', at: claimedAt },
    })
    ;(odd.run as { at: unknown }).at = 5
    seed(odd, task(2, { status: 'claimed', owner: 'old' }))
    expect(cli('stale', '--hours', '0').stdout).not.toContain('workflow:w')
    expect(cli('doctor').json.findings.some((finding: { code: string }) => finding.code === 'claim-residue')).toBe(true)
    const healed = cli('heartbeat', '1')
    expect(healed.stderr).toContain('dropped stale run on task(s): 1')
    expect(byId(1).run).toBeUndefined()

    const before = readFileSync(board, 'utf8')
    const refused = cli('heartbeat', '2', '--run', 'session:abc')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('claim predates timestamps; release and re-claim with --run')
    expect(refused.stderr).not.toContain('healed:')
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('journals an explicit add route with a reason, and trims decide summaries', () => {
    const plain = cli('add', 'ux-worker', 'Plain', '--route', 'grok_patch', '--reason', '  lead pick  ', '--by', 'lead')
    expect(plain.status).toBe(0)
    expect(plain.json.jev).toBeUndefined()
    expect(plain.json.decisions[0]).toMatchObject({
      kind: 'route',
      from: null,
      to: 'grok_patch',
      reason: 'lead pick',
      by: 'lead',
    })
    const matched = cli(
      'add',
      'ux-worker',
      'Match',
      '--route',
      'haiku_fork',
      '--jev',
      JSON.stringify(verdict()),
      '--reason',
      'same route',
      '--by',
      'lead',
    )
    expect(matched.json.route).toBe('haiku_fork')
    expect(matched.json.decisions[0]).toMatchObject({
      kind: 'route',
      from: 'haiku_fork',
      to: 'haiku_fork',
      reason: 'same route',
      by: 'lead',
    })
    seed(task(1))
    const decided = cli('decide', '1', '--summary', '  ship fix A  ')
    expect(decided.status).toBe(0)
    expect(byId(1).decisions?.[0]).toMatchObject({ kind: 'choice', summary: 'ship fix A' })
    const blank = cli('decide', '1', '--summary', '   ')
    expect(blank.status).toBe(1)
    expect(blank.stderr).toContain('--summary must not be empty')
    expect(byId(1).decisions).toHaveLength(1)
  })

  it('takes the verdict route on an open task with a null route and no previous verdict', () => {
    seed(
      task(1, { route: null }),
      task(2, { route: null }),
      task(3, { route: 'lead' }),
      task(4, { route: null, jev: verdict({ route: 'haiku_fork' }) }),
    )
    const held = cli(
      'jev',
      '1',
      JSON.stringify(verdict({ route: 'needs_lead', jevRoute: 'haiku_fork', holds: ['needs_decision'] })),
    )
    expect(held.status).toBe(0)
    expect(held.json.route).toBe('needs_lead')
    expect(held.json.note).toBeUndefined()
    expect(byId(1).jev?.holds).toEqual(['needs_decision'])
    expect(byId(1).decisions?.map((decision) => decision.kind)).toEqual(['route'])
    expect(byId(1).decisions?.[0]).toMatchObject({
      kind: 'route',
      from: null,
      to: 'needs_lead',
      reason: 'jev verdict',
      by: 'jev',
      verdict: null,
    })
    const moved = cli('jev', '2', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(moved.status).toBe(0)
    expect(moved.json.route).toBe('sol_patch')
    expect(moved.json.note).toBeUndefined()
    const unknown = cli('jev', '3', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(unknown.json.route).toBe('lead')
    expect(unknown.json.note).toContain('not the previous verdict route')
    expect(findingCodes(cli('doctor'))).toContain('unknown-route')
    const previous = cli('jev', '4', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(previous.json.route).toBe('sol_patch')
    expect(previous.json.note).toBeUndefined()
    expect(byId(4).decisions?.map((decision) => decision.kind)).toEqual(['jev', 'route'])
    expect(byId(4).decisions?.[1]).toMatchObject({ from: null, to: 'sol_patch', by: 'jev' })
  })

  it('applies a hold verdict after release when it was stored while the null-route task was claimed', () => {
    seed(task(1, { route: null, status: 'claimed', owner: 'worker', claimedAt: hoursAgo(1) }))
    const hold = JSON.stringify(verdict({ route: 'needs_lead', jevRoute: 'haiku_fork', holds: ['needs_decision'] }))
    const whileClaimed = cli('jev', '1', hold)
    expect(whileClaimed.json.route).toBeNull()
    expect(whileClaimed.json.note).toContain('task is claimed')
    expect(cli('release', '1').status).toBe(0)
    const afterRelease = cli('jev', '1', hold)
    expect(afterRelease.json.route).toBe('needs_lead')
    expect(afterRelease.json.note).toBeUndefined()
    const claim = cli('claim', 'ux-worker', 'someone', '--id', '1')
    expect(claim.status).toBe(1)
    expect(claim.stderr).toContain('held for the lead')
    expect(byId(1).status).toBe('open')
  })

  it('keeps a null route that a lead route decision explains', () => {
    seed(
      task(1, {
        route: null,
        decisions: [
          {
            at: '2026-01-01T00:00:00.000Z',
            kind: 'route',
            from: 'haiku_fork',
            to: null,
            reason: 'hand edit',
            by: 'lead',
          },
        ],
      }),
    )
    const result = cli('jev', '1', JSON.stringify(verdict({ route: 'sol_patch', jevRoute: 'sol_patch' })))
    expect(result.json.route).toBeNull()
    expect(result.json.note).toContain('changes it')
  })
})

describe('accept, tag, and catalog roles', () => {
  it('requires --accept for every role except lead, and stores it trimmed', () => {
    const missing = cli('add', 'qa-worker', 'Verify', '--accept', '')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--accept')
    const refused = spawnSync(process.execPath, [CLI, 'add', 'ux-worker', 'Fix it'], {
      encoding: 'utf8',
      env: { ...process.env, TEAM_TASKS_FILE: board },
    })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('--accept')
    expect(refused.stderr).toContain('ux-worker')
    const lead = cli('add', 'lead', 'Split the work', '--route', 'needs_lead')
    expect(lead.status).toBe(0)
    expect(lead.json).not.toHaveProperty('accept')
    const stored = cli('add', 'specialist-worker', 'Retry the stalled job', '--accept', '  the job is not billed twice  ')
    expect(stored.status).toBe(0)
    expect(stored.json.accept).toBe('the job is not billed twice')
    expect(cli('add', 'qa-worker', 'Too long', '--accept', 'x'.repeat(601)).stderr).toContain('600')
    expect(cli('add', 'qa-worker', 'Fits', '--accept', `${'ab '.repeat(199)}abc`).status).toBe(0)
  })

  it('refuses a credential or an email in a gated task title or accept', () => {
    seed()
    const token = cli('add', 'qa-worker', 'Verify login', '--accept', `login works with ghp_${'a'.repeat(30)}`)
    expect(token.status).toBe(1)
    expect(token.stderr).toContain('a GitHub token')
    expect(token.stderr).not.toContain('ghp_')
    const email = cli('add', 'qa-worker', 'Mail drod@example.com the report', '--accept', 'report sent')
    expect(email.status).toBe(1)
    expect(email.stderr).toContain('title contains an email address')
    expect(read()).toEqual([])
  })

  it('refuses a role outside the catalog and lists the known roles', () => {
    seed()
    const refused = cli('add', 'billing-guy', 'Count invoices', '--accept', 'invoices match')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('unknown role')
    expect(refused.stderr).toContain('specialist-worker')
    expect(refused.stderr).toContain('backend-worker')
    expect(refused.stderr).toContain('--tag billing')
    const team = cli('add', 'payments-runtime-gate', 'Gate the runtime', '--accept', 'gate passes')
    expect(team.stderr).toContain('put the team or project name in --tag (for example --tag payments)')
    expect(cli('add', 'worker', 'x', '--accept', 'y').stderr).toContain('--tag <team-name>')
    expect(cli('add', 'unassigned', 'x', '--accept', 'y').stderr).toContain('no role was given; use one of:')
    expect(read()).toEqual([])
  })

  it('keeps a stored off-catalog role claimable and reports it on open tasks', () => {
    seed(task(1, { role: 'clip-worker' }), task(2, { role: 'clip-worker', status: 'done', owner: 'old' }))
    expect(cli('claim', 'clip-worker', 'me').json).toMatchObject({ id: 1, status: 'claimed', owner: 'me' })
    const codes = findingCodes(cli('doctor'))
    expect(codes).toContain('off-catalog-role')
    const finding = cli('doctor').json.findings.find((item: { code: string }) => item.code === 'off-catalog-role')
    expect(finding).toMatchObject({ level: 'info', id: 1 })
    expect(finding.message).toContain('clip-worker')
    expect(codes.filter((code: string) => code === 'off-catalog-role')).toHaveLength(1)
  })

  it('stores a tag and list --tag filters on it', () => {
    cli('add', 'ux-worker', 'Wizard', '--tag', 'wizard-1276', '--accept', 'labels fit')
    cli('add', 'qa-worker', 'Other', '--tag', 'other', '--accept', 'suite passes')
    cli('add', 'lead', 'Untagged split')
    expect(cli('add', 'ux-worker', 'Bad', '--tag', 'Wizard', '--accept', 'no').status).toBe(1)
    expect(cli('add', 'ux-worker', 'Bad', '--tag', '-nope', '--accept', 'no').stderr).toContain('--tag')
    expect(cli('list', '--tag', 'wizard-1276', '--json').json.map((item: Task) => item.title)).toEqual(['Wizard'])
    expect(cli('list', '--json').json).toHaveLength(3)
  })
})

const HASH = 'ab'.repeat(32)

// A check carries `basis`, the journal length it read; `basis: 0` fits a write to a task with no journal yet.
function judgment(over: Record<string, unknown> = {}) {
  const tool = over.tool ?? 'check'
  return {
    ...(tool === 'check' ? { basis: 0 } : {}),
    kind: 'judgment',
    at: '2026-01-01T00:00:00.000Z',
    by: 'worker',
    tool: 'check',
    question: 'Does the evidence pass?',
    outcome: 'confirmed',
    answer: 'fits',
    p: 0.9,
    confidence: null,
    reasons: [] as string[],
    evidence: ['a.png'],
    requestHash: HASH,
    receipt: '/tmp/r.json',
    ...over,
  }
}

describe('done gate', () => {
  const gated = (over: Record<string, unknown> = {}) => ({
    id: 7,
    accept: 'the label is whole',
    status: 'claimed',
    evidence: ['a.png'],
    decisions: [] as Record<string, unknown>[],
    ...over,
  })

  it.each([
    ['no evidence', gated({ evidence: [] }), ['NeverDoneUnchecked', 'NeverDoneUnconfirmed']],
    ['evidence and no check', gated(), ['NeverDoneUnconfirmed']],
    ['confirmed check', gated({ decisions: [judgment()] }), []],
    [
      'answered ask then a confirmed check',
      gated({
        decisions: [judgment({ tool: 'ask', outcome: 'answered', answer: 'yes', evidence: undefined }), judgment()],
      }),
      [],
    ],
    [
      'later reject voids the confirm',
      gated({ decisions: [judgment(), judgment({ outcome: 'rejected', answer: 'failing' })] }),
      ['NeverDoneUnconfirmed'],
    ],
    [
      'later hold voids the confirm',
      gated({ decisions: [judgment(), judgment({ outcome: 'hold', answer: null })] }),
      ['NeverDoneUnconfirmed'],
    ],
    [
      'reject after a lead accept voids it',
      gated({
        decisions: [
          judgment({ outcome: 'hold', answer: null }),
          { kind: 'accept', evidence: ['a.png'] },
          judgment({ outcome: 'rejected', answer: 'failing' }),
        ],
      }),
      ['NeverDoneUnconfirmed'],
    ],
    [
      'confirm after a reject',
      gated({ decisions: [judgment({ outcome: 'rejected', answer: 'failing' }), judgment()] }),
      [],
    ],
    [
      'rejected check',
      gated({ decisions: [judgment({ outcome: 'rejected', answer: 'failing' })] }),
      ['NeverDoneUnconfirmed'],
    ],
    [
      'lead accept after a hold',
      gated({ decisions: [judgment({ outcome: 'hold', answer: null }), { kind: 'accept', evidence: ['a.png'] }] }),
      [],
    ],
    [
      'answered ask after confirm',
      gated({
        decisions: [judgment(), judgment({ tool: 'ask', outcome: 'answered', answer: 'yes', evidence: undefined })],
      }),
      ['NeverDoneUnconfirmed'],
    ],
    ['choice after confirm', gated({ decisions: [judgment(), { kind: 'choice' }] }), ['NeverDoneUnconfirmed']],
    ['release after confirm', gated({ decisions: [judgment(), { kind: 'release' }] }), ['NeverDoneUnconfirmed']],
    ['evidence changed', gated({ evidence: ['b.png'], decisions: [judgment()] }), ['NeverDoneUnconfirmed']],
    [
      'same evidence, different order',
      gated({ evidence: ['b.png', 'a.png'], decisions: [judgment({ evidence: ['a.png', 'b.png'] })] }),
      [],
    ],
    [
      'open ask hold',
      gated({ decisions: [judgment(), judgment({ tool: 'ask', outcome: 'hold', answer: null })] }),
      ['NeverDoneWhileHeld'],
    ],
    [
      'choice clears the hold',
      gated({ decisions: [judgment({ tool: 'ask', outcome: 'hold', answer: null }), { kind: 'choice' }, judgment()] }),
      [],
    ],
    [
      'later hold stays open',
      gated({
        decisions: [
          judgment({ tool: 'ask', outcome: 'hold', answer: null }),
          { kind: 'choice' },
          judgment({ tool: 'decide', outcome: 'hold', answer: null }),
          judgment(),
        ],
      }),
      ['NeverDoneWhileHeld'],
    ],
    ['legacy task', { id: 1, evidence: [] }, []],
  ])('%s', (_name, subject, expected) => {
    const names = doneBlockers(subject).map((blocker: string) => blocker.split(':')[0])
    expect(names).toEqual(expected)
  })

  it('currentCheck is the latest check for the current evidence', () => {
    const older = judgment({ outcome: 'hold' })
    const newer = judgment({ outcome: 'confirmed', evidence: ['b.png'] })
    expect(currentCheck(gated({ evidence: ['a.png'], decisions: [older, newer] }))).toBe(older)
    expect(currentCheck(gated({ evidence: ['c.png'], decisions: [older] }))).toBeNull()
  })

  it('refuses done --force when the gate is open, and stays idempotent once done', () => {
    seed(task(1, { status: 'claimed', owner: 'worker', accept: 'labels fit', evidence: ['a.png'] }))
    const forced = cli('done', '1', '--force')
    expect(forced.status).toBe(1)
    expect(forced.stderr).toContain('not done-able')
    expect(forced.stderr).toContain('NeverDoneUnconfirmed')
    expect(byId(1).status).toBe('claimed')
    const payload = judgment()
    expect(cli('judgment', '1', JSON.stringify(payload)).status).toBe(0)
    expect(cli('done', '1', '--owner', 'worker').status).toBe(0)
    expect(cli('done', '1', '--owner', 'worker').status).toBe(0)
    expect(byId(1).status).toBe('done')
  })

  // Split in three: all twelve CLI spawns in one test ran past the 5s limit on the CI runner.
  it('refuses evidence and a judgment before a claim', () => {
    seed(task(1, { status: 'open', accept: 'labels fit', owner: null }))
    expect(cli('evidence', '1', 'a.png').stderr).toContain('needs a claim')
    const askHold = judgment({ tool: 'ask', outcome: 'hold', answer: null })
    delete askHold.evidence
    expect(cli('judgment', '1', JSON.stringify(askHold)).stderr).toContain('needs a claim')
    expect(cli('show', '9').status).toBe(1)
  })

  it('takes evidence and a check after a claim, and refuses an accept by the owner', () => {
    seed(task(1, { status: 'open', accept: 'labels fit', owner: null }))
    expect(cli('claim', 'ux-worker', 'worker', '--id', '1').status).toBe(0)
    expect(cli('evidence', '1', 'a.png').status).toBe(0)
    const check = JSON.stringify(judgment({ outcome: 'hold', answer: null }))
    expect(cli('judgment', '1', check).status).toBe(0)
    expect(cli('accept', '1', '--reason', 'read it', '--by', 'worker').stderr).toContain('differ')
  })

  it('journals a release after an accept, and a forced done still refuses', () => {
    seed(task(1, { status: 'claimed', owner: 'worker', accept: 'labels fit', evidence: ['a.png'] }))
    const check = JSON.stringify(judgment({ outcome: 'hold', answer: null }))
    expect(cli('judgment', '1', check).status).toBe(0)
    expect(cli('accept', '1', '--reason', 'read it', '--by', 'lead').status).toBe(0)
    expect(cli('release', '1').status).toBe(0)
    expect(byId(1).decisions?.at(-1)).toMatchObject({ kind: 'release', owner: 'worker' })
    expect(cli('done', '1', '--force').stderr).toContain('NeverDoneUnconfirmed')
    expect(cli('show', '1').json).toMatchObject({ id: 1, status: 'open' })
  })

  it('refuses a judgment on a gated task from anyone but the owner', () => {
    seed(task(1, { status: 'claimed', owner: 'worker', accept: 'labels fit', evidence: ['a.png'] }))
    const other = cli('judgment', '1', JSON.stringify(judgment({ by: 'someone-else' })))
    expect(other.status).toBe(1)
    expect(other.stderr).toContain('must be by the owner')
    expect(byId(1).decisions ?? []).toEqual([])
    expect(cli('judgment', '1', JSON.stringify(judgment())).status).toBe(0)
  })

  const voidingEntries: [string, Record<string, unknown>][] = [
    ['choice', { kind: 'choice', at: '2026-01-01T00:00:00.000Z', summary: 'new layout', ref: null, by: 'lead' }],
    ['answered question', judgment({ tool: 'decide', outcome: 'answered', answer: 'a', evidence: undefined })],
    ['release', { kind: 'release', at: '2026-01-01T00:00:00.000Z', owner: 'worker' }],
  ]

  // One voiding entry per test: all three plus the edge cases in one test ran ~5s on the CI runner, over the 5s limit.
  it.each(voidingEntries)('refuses a check that read the journal before this entry: %s', (_name, voiding) => {
    seed(
      task(1, {
        status: 'claimed',
        owner: 'worker',
        accept: 'labels fit',
        evidence: ['a.png'],
        decisions: [voiding],
      }),
    )
    const late = cli('judgment', '1', JSON.stringify(judgment({ basis: 0 })))
    expect(late.status).toBe(1)
    expect(late.stderr).toContain('while the check ran')
    expect(cli('judgment', '1', JSON.stringify(judgment({ basis: 1 }))).status).toBe(0)
    expect(cli('done', '1', '--owner', 'worker').status).toBe(0)
  })

  it('lands a check that read before a hold, and refuses a bad basis', () => {
    const askHold = judgment({ tool: 'ask', outcome: 'hold', answer: null, evidence: undefined })
    // A hold, an accept, or a check is not a voiding entry, so a check that read before it still lands.
    seed(
      task(1, { status: 'claimed', owner: 'worker', accept: 'labels fit', evidence: ['a.png'], decisions: [askHold] }),
    )
    expect(cli('judgment', '1', JSON.stringify(judgment({ basis: 0 }))).status).toBe(0)
    seed(task(1, { status: 'claimed', owner: 'worker', accept: 'labels fit', evidence: ['a.png'] }))
    expect(cli('judgment', '1', JSON.stringify(judgment({ basis: 1 }))).stderr).toContain('fewer journal entries')
    const unbased = judgment()
    delete unbased.basis
    expect(cli('judgment', '1', JSON.stringify(unbased)).stderr).toContain('basis must be')
    expect(cli('judgment', '1', JSON.stringify(judgment({ basis: -1 }))).stderr).toContain('basis must be')
    const askWithBasis = { ...askHold, basis: 0 }
    expect(cli('judgment', '1', JSON.stringify(askWithBasis)).stderr).toContain('basis is only stored on a check')
    expect(byId(1).decisions ?? []).toEqual([])
  })

  it('accepts a hold on an ungated task whose evidence is a local file it never retained', () => {
    const local = join(dir, 'notes.md')
    writeFileSync(local, 'checked by hand\n')
    seed(
      task(1, {
        status: 'claimed',
        owner: 'worker',
        evidence: [local],
        decisions: [judgment({ outcome: 'hold', answer: null, evidence: [local] })],
      }),
    )
    const result = cli('accept', '1', '--reason', 'because', '--by', 'lead')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('accept refuses a rejected check, a confirmed check, no check, and empty evidence', () => {
    seed(task(1, { status: 'claimed', owner: 'worker', accept: 'labels fit', evidence: ['a.png'] }))
    expect(cli('accept', '1', '--reason', 'because', '--by', 'lead').stderr).toContain('no check')
    expect(cli('judgment', '1', JSON.stringify(judgment({ outcome: 'rejected', answer: 'failing' }))).status).toBe(0)
    expect(cli('accept', '1', '--reason', 'because', '--by', 'lead').stderr).toContain('rejected')
    seed(
      task(1, {
        status: 'claimed',
        owner: 'worker',
        accept: 'labels fit',
        evidence: ['a.png'],
        decisions: [judgment()],
      }),
    )
    expect(cli('accept', '1', '--reason', 'because', '--by', 'lead').stderr).toContain('already confirmed')
    seed(
      task(1, {
        status: 'claimed',
        owner: 'worker',
        accept: 'labels fit',
        decisions: [judgment({ outcome: 'hold', evidence: [] })],
      }),
    )
    expect(cli('accept', '1', '--reason', 'because', '--by', 'lead').stderr).toContain('no evidence')
    seed(
      task(1, {
        status: 'claimed',
        owner: 'worker',
        accept: 'labels fit',
        evidence: ['a.png', 'b.png'],
        decisions: [judgment({ outcome: 'hold', answer: null, evidence: ['a.png'] })],
      }),
    )
    expect(cli('accept', '1', '--reason', 'because', '--by', 'lead').stderr).toContain('evidence changed')
  })

  it('doctor reports an open hold and a gated task an old checkout marked done', () => {
    seed(
      task(1, {
        status: 'claimed',
        owner: 'worker',
        accept: 'labels fit',
        evidence: ['a.png'],
        decisions: [judgment({ tool: 'ask', outcome: 'hold', answer: null, evidence: undefined })],
      }),
      task(2, { status: 'done', owner: 'old', accept: 'labels fit', evidence: [] }),
    )
    const report = cli('doctor')
    expect(report.json.findings).toContainEqual(expect.objectContaining({ level: 'info', code: 'open-hold', id: 1 }))
    expect(report.json.findings).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'done-unconfirmed', id: 2 }),
    )
    expect(report.status).toBe(0)
  })
})

describe('archive', () => {
  const daysAgo = (days: number) => hoursAgo(days * 24)

  const bulky = 'x'.repeat(4000)
  const seedArchivable = () =>
    seed(
      task(1, { status: 'done', doneAt: daysAgo(40), title: bulky, evidence: ['a.png'] }),
      task(2, { after: [1] }),
      task(3, { status: 'cancelled', title: 'dropped' }),
      task(4, { status: 'done', doneAt: hoursAgo(1), title: 'fresh' }),
      task(5),
    )
  const seedArchived = () => {
    seedArchivable()
    expect(cli('archive', '--older-than-days', '7').status).toBe(0)
  }

  // Split in four: all sixteen CLI spawns in one test ran past the 5s limit on the CI runner.
  it('moves old finished tasks to stubs and archives each one once', () => {
    seedArchivable()
    const first = cli('archive', '--older-than-days', '7')
    expect(first.status).toBe(0)
    expect(first.json.archived).toBe(2)
    expect(first.json.bytesAfter).toBeLessThan(first.json.bytesBefore)
    expect(byId(1)).toEqual({ id: 1, status: 'done', archived: true })
    expect(byId(3)).toEqual({ id: 3, status: 'cancelled', archived: true })
    expect(byId(4).title).toBe('fresh')
    expect(byId(2).title).toBe('task 2')
    const lines = readFileSync(`${board}.archive.jsonl`, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ id: 1, title: bulky, evidence: ['a.png'] })

    const again = cli('archive', '--older-than-days', '7')
    expect(again.json).toMatchObject({ archived: 0 })
    expect(readFileSync(`${board}.archive.jsonl`, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('show and list still read archived tasks', () => {
    seedArchived()
    expect(cli('show', '1').json).toMatchObject({
      id: 1,
      title: bulky,
      status: 'done',
      archived: true,
      evidence: ['a.png'],
    })
    expect(cli('list', '--json').json.map((item: Task) => item.id)).toEqual([2, 5])
    expect(cli('list', '--all', '--json').json.find((item: Task) => item.id === 1)).toMatchObject({ title: bulky })
    expect(cli('list', '--status', 'done', '--json').json.map((item: Task) => item.id)).toEqual([1, 4])
  })

  it('claim and add still work after an archive', () => {
    seedArchived()
    expect(cli('claim', 'ux-worker', 'me', '--id', '2').status).toBe(0)
    const added = cli('add', 'qa-worker', 'follow-up', '--after', '1')
    expect(added.status).toBe(0)
    expect(added.json.id).toBe(6)
    expect(added.json.after).toEqual([1])
  })

  it('refuses writes to an archived task', () => {
    seedArchived()
    const before = readFileSync(board, 'utf8')
    for (const args of [
      ['evidence', '1', 'note'],
      ['done', '1'],
      ['claim', 'ux-worker', 'other', '--id', '1'],
      ['heartbeat', '1'],
    ]) {
      const refused = cli(...args)
      expect(refused.status, args.join(' ')).toBe(1)
      expect(refused.stderr, args.join(' ')).toContain('task 1 is archived')
    }
    expect(readFileSync(board, 'utf8')).toBe(before)
  })

  it('stubs a task whose archive line is already there and does not append it again', () => {
    const finished = task(1, { status: 'done', doneAt: daysAgo(40), title: 'kept' })
    seed(finished)
    writeFileSync(`${board}.archive.jsonl`, `${JSON.stringify(finished)}\n`)
    const result = cli('archive', '--older-than-days', '7')
    expect(result.status).toBe(0)
    expect(result.json.archived).toBe(1)
    expect(readFileSync(`${board}.archive.jsonl`, 'utf8')).toBe(`${JSON.stringify(finished)}\n`)
    expect(byId(1)).toEqual({ id: 1, status: 'done', archived: true })
    expect(cli('show', '1').json).toMatchObject({ title: 'kept', archived: true })
  })

  it('doctor tolerates stubs and reports a board over 300 KB', () => {
    writeFileSync(
      board,
      `${JSON.stringify(
        {
          version: 1,
          tasks: [
            { id: 1, status: 'done', archived: true },
            { id: 2, status: 'cancelled', archived: true },
            task(3, { title: 'y'.repeat(320 * 1024) }),
          ],
        },
        null,
        2,
      )}\n`,
    )
    const report = cli('doctor')
    expect(report.status).toBe(0)
    expect(report.stderr).not.toContain('TypeError')
    const size = report.json.findings.find((item: { code: string }) => item.code === 'board-size')
    expect(size).toMatchObject({ level: 'info', code: 'board-size' })
    expect(size.message).toContain('archive --older-than-days 7')
  })
})

describe('archive recovery', () => {
  const daysAgo = (days: number) => hoursAgo(days * 24)
  const archiveFile = () => `${board}.archive.jsonl`

  it('skips a torn last line on read, reports it, and cuts it on the next archive run', () => {
    seed(task(1, { status: 'done', doneAt: daysAgo(40), title: 'old' }), task(2))
    writeFileSync(archiveFile(), `${JSON.stringify({ id: 7, status: 'done', title: 'kept' })}\n{"id":9,"ti`)
    expect(cli('list', '--all').status).toBe(0)
    expect(cli('list', '--status', 'claimed').status).toBe(0)
    const doctor = cli('doctor')
    expect(JSON.stringify(doctor.json)).toContain('torn-archive')
    const run = cli('archive', '--older-than-days', '7')
    expect(run.status, run.stderr).toBe(0)
    expect(run.stderr).toContain('torn last line')
    const lines = readFileSync(archiveFile(), 'utf8').split('\n').filter(Boolean)
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([7, 1])
    expect(cli('show', '1').json).toMatchObject({ title: 'old', archived: true })
  })

  it('says so when it cuts a torn line even though no task moves', () => {
    seed(task(1))
    writeFileSync(archiveFile(), `${JSON.stringify({ id: 7, status: 'done' })}\n{"id":9,"ti`)
    const run = cli('archive', '--older-than-days', '7')
    expect(run.status, run.stderr).toBe(0)
    expect(run.json).toMatchObject({ archived: 0, tornBytesCut: 11 })
    expect(run.stderr).toContain('cut a torn last line (11 bytes)')
    expect(readFileSync(archiveFile(), 'utf8')).toBe(`${JSON.stringify({ id: 7, status: 'done' })}\n`)
  })

  it('still throws on a bad line that is not the last one', () => {
    seed(task(1, { status: 'done', doneAt: daysAgo(40) }))
    writeFileSync(archiveFile(), `not json\n${JSON.stringify({ id: 7, status: 'done' })}\n`)
    const run = cli('archive', '--older-than-days', '7')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('unreadable archive line 1')
  })

  it('appends a task whose id is archived with different content, and the newer line wins', () => {
    seed(task(1, { status: 'done', doneAt: daysAgo(40), title: 'current task', evidence: ['b.png'] }))
    writeFileSync(archiveFile(), `${JSON.stringify({ id: 1, status: 'cancelled', title: 'stale task' })}\n`)
    expect(cli('archive', '--older-than-days', '7').json).toMatchObject({ archived: 1 })
    expect(readFileSync(archiveFile(), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(cli('show', '1').json).toMatchObject({ title: 'current task', evidence: ['b.png'], status: 'done' })
  })

  it('keeps a gated task that was forced done unconfirmed on the board', () => {
    seed(task(1, { status: 'done', doneAt: daysAgo(40), accept: 'labels fit', evidence: [] }))
    expect(cli('archive', '--older-than-days', '7').json).toMatchObject({ archived: 0 })
    expect(byId(1)).toMatchObject({ accept: 'labels fit' })
    expect(JSON.stringify(cli('doctor').json)).toContain('done-unconfirmed')
  })
})

describe('durable evidence', () => {
  it.each(['symlink', 'oversized'] as const)(
    'refuses %s file evidence on gated tasks without changing the board',
    (kind) => {
      seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review evidence' }))
      const source = join(dir, 'report.txt')
      const link = join(dir, 'link.txt')
      const big = join(dir, 'big.txt')
      writeFileSync(source, 'original')
      symlinkSync(source, link)
      writeFileSync(big, '')
      truncateSync(big, 25 * 1024 * 1024 + 1)
      const result = cli('evidence', '1', kind === 'symlink' ? link : big)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/retain|evidence/i)
      expect(byId(1).evidence ?? []).toEqual([])
    },
  )

  it.each(['confirmed', 'hold'] as const)('blocks %s for legacy mutable local evidence', (outcome) => {
    const legacy = join(dir, 'legacy.txt')
    writeFileSync(legacy, 'checked content')
    seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review evidence', evidence: [legacy] }))
    const verdict = cli('judgment', '1', JSON.stringify(judgment({ by: 'me', outcome, evidence: [legacy] })))
    expect(verdict.status, verdict.stderr).toBe(0)
    writeFileSync(legacy, 'changed content')
    const action =
      outcome === 'hold' ? ['accept', '1', '--reason', 'Reviewed', '--by', 'lead'] : ['done', '1', '--owner', 'me']
    const result = cli(...action)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/retain|evidence/i)
    expect(byId(1).status).toBe('claimed')
    const reattached = cli('evidence', '1', legacy)
    expect(reattached.status, reattached.stderr).toBe(0)
    const [retained] = reattached.json.evidence as [string]
    expect(retained).not.toBe(legacy)
    expect(readFileSync(retained, 'utf8')).toBe('changed content')
    expect(cli(...action).status).toBe(1)
    const fresh = cli('judgment', '1', JSON.stringify(judgment({ by: 'me', outcome, evidence: [retained] })))
    expect(fresh.status, fresh.stderr).toBe(0)
    expect(cli(...action).status).toBe(0)
  })

  it('preserves non-file references on gated tasks', () => {
    seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review evidence' }))
    const refs = ['https://example.com/proof', 'plain note']
    const added = cli('evidence', '1', ...refs)
    expect(added.status, added.stderr).toBe(0)
    expect(added.json.evidence).toEqual(refs)
  })

  it('refuses to start a check on an existing legacy file until it is retained', () => {
    const legacy = join(dir, 'legacy.txt')
    writeFileSync(legacy, 'report')
    seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review evidence', evidence: [legacy] }))
    const start = (evidence: string[]) =>
      cli('check-start', '1', JSON.stringify({ by: 'me', token: 'check', evidence, basis: 0 }))
    expect(start([legacy]).status).toBe(1)
    const reattached = cli('evidence', '1', legacy)
    expect(reattached.status, reattached.stderr).toBe(0)
    expect(start(reattached.json.evidence).status).toBe(0)
  })

  it('replaces a legacy symlink only when a same-named regular reattachment has the same bytes', () => {
    const linkDir = join(dir, 'links')
    const copyDir = join(dir, 'copies')
    mkdirSync(linkDir)
    mkdirSync(copyDir)
    const target = join(dir, 'original.txt')
    const legacy = join(linkDir, 'report.txt')
    const copy = join(copyDir, 'report.txt')
    writeFileSync(target, 'checked content')
    symlinkSync(target, legacy)
    writeFileSync(copy, 'different content')
    seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review evidence', evidence: [legacy] }))
    expect(cli('evidence', '1', copy).json.evidence).toContain(legacy)
    writeFileSync(copy, 'checked content')
    const result = cli('evidence', '1', copy)
    expect(result.status, result.stderr).toBe(0)
    expect(result.json.evidence).not.toContain(legacy)
    expect(result.json.evidence.some((item: string) => readFileSync(item, 'utf8') === 'checked content')).toBe(true)
  })

  it.each(['confirmed', 'hold'] as const)('blocks completion with damaged %s evidence until repaired', (outcome) => {
    seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review the report' }))
    const source = join(dir, 'report.txt')
    writeFileSync(source, 'original report')
    const attached = cli('evidence', '1', source)
    expect(attached.status, attached.stderr).toBe(0)
    const [retained] = attached.json.evidence as [string]
    const verdict = cli('judgment', '1', JSON.stringify(judgment({ by: 'me', outcome, evidence: [retained] })))
    expect(verdict.status, verdict.stderr).toBe(0)
    rmSync(retained)
    writeFileSync(retained, 'damaged report')

    const action =
      outcome === 'hold' ? ['accept', '1', '--reason', 'Reviewed', '--by', 'lead'] : ['done', '1', '--owner', 'me']
    const refused = cli(...action)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/retained evidence.*checksum/i)
    expect(byId(1).status).toBe('claimed')

    expect(cli('evidence', '1', source).status).toBe(0)
    expect(cli(...action).status).toBe(0)
  })

  it('restores a damaged retained copy when the original bytes are reattached', () => {
    seed(task(1))
    const source = join(dir, 'report.txt')
    writeFileSync(source, 'original report')
    const first = cli('evidence', '1', source)
    expect(first.status, first.stderr).toBe(0)
    const [retained] = first.json.evidence as [string]
    rmSync(retained)
    writeFileSync(retained, 'damaged report')

    const repaired = cli('evidence', '1', source)
    expect(repaired.status, repaired.stderr).toBe(0)
    expect(repaired.json.evidence).toEqual([retained])
    expect(readFileSync(retained, 'utf8')).toBe('original report')
  })

  it('pins a gated task’s local evidence to the attached bytes', () => {
    seed(task(1, { status: 'claimed', owner: 'me', accept: 'Review the report' }))
    const directory = mkdtempSync(join(import.meta.dirname, '..', '.team-tasks-evidence-'))
    const report = join(directory, 'report.txt')
    try {
      writeFileSync(report, 'first report')
      const first = cli('evidence', '1', report)
      expect(first.status, first.stderr).toBe(0)
      const [firstCopy] = first.json.evidence as string[]
      expect(firstCopy).not.toBe(report)
      writeFileSync(report, 'second report')
      expect(readFileSync(firstCopy!, 'utf8')).toBe('first report')

      const second = cli('evidence', '1', report)
      expect(second.status, second.stderr).toBe(0)
      const copies = second.json.evidence as string[]
      expect(copies.map((copy) => readFileSync(copy, 'utf8'))).toEqual(['first report', 'second report'])
      expect(cli('evidence', '1', report).json.evidence).toEqual(copies)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('copies nothing when the board would refuse the write', () => {
    seed(task(1, { status: 'claimed', owner: 'a' }))
    const secret = join(dir, '.env')
    writeFileSync(secret, 'X=1')
    const refused = cli('done', '1', '--owner', 'WRONG', '--evidence', secret)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('owned by a')
    expect(existsSync(`${board}.artifacts`)).toBe(false)
    expect(byId(1).status).toBe('claimed')
  })

  it('copies a temp file, leaves everything else, and dedupes the same bytes', () => {
    seed(task(1))
    const source = join(dir, 'shot.txt')
    writeFileSync(source, 'pixels')
    const nonTempRootFixtureDir = mkdtempSync(join(realpathSync(homedir()), '.team-tasks-durable-'))
    const kept = join(nonTempRootFixtureDir, 'kept.txt')
    writeFileSync(kept, 'kept')
    try {
      const missing = join(dir, 'missing.txt')
      const folder = join(dir, 'folder')
      mkdirSync(folder)
      symlinkSync(source, join(dir, 'link.txt'))
      const added = cli(
        'evidence',
        '1',
        source,
        kept,
        'https://example.com/a',
        'plain note',
        missing,
        folder,
        join(dir, 'link.txt'),
      )
      expect(added.status, added.stderr).toBe(0)
      const [copied, ...rest] = added.json.evidence as string[]
      expect(copied.replaceAll('\\', '/')).toMatch(/tasks\.json\.artifacts\/1\/[0-9a-f]{12}\/shot\.txt$/)
      expect(readFileSync(copied, 'utf8')).toBe('pixels')
      expect(rest).toEqual([kept, 'https://example.com/a', 'plain note', missing, folder, join(dir, 'link.txt')])
      expect(readFileSync(kept, 'utf8')).toBe('kept')
      expect(cli('evidence', '1', source).json.evidence).toEqual(added.json.evidence)
      expect(readdirSync(join(dir, 'tasks.json.artifacts', '1'))).toEqual([copied.split(/[\\/]/).at(-2)])
    } finally {
      rmSync(nonTempRootFixtureDir, { recursive: true, force: true })
    }
  })

  it('does not create an artifact directory for a missing or archived id', () => {
    const source = join(dir, 'shot.txt')
    writeFileSync(source, 'pixels')
    expect(cli('evidence', '99', source).status).toBe(1)
    writeFileSync(
      board,
      `${JSON.stringify({ version: 1, tasks: [{ id: 1, status: 'done', archived: true }] }, null, 2)}\n`,
    )
    const refused = cli('decide', '1', '--summary', 'nope', '--ref', source, '--by', 'lead')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('task 1 is archived')
    expect(existsSync(join(dir, 'tasks.json.artifacts'))).toBe(false)
  })

  it('stores an oversize temp file unchanged and says so', () => {
    seed(task(1, { status: 'claimed', owner: 'me' }))
    const big = join(dir, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, 25 * 1024 * 1024 + 1)
    const done = cli('done', '1', '--owner', 'me', '--evidence', big)
    expect(done.status, done.stderr).toBe(0)
    expect(done.stderr).toContain('over 25 MB')
    expect(done.stderr).toContain(big)
    expect(byId(1).evidence).toEqual([big])
    expect(existsSync(join(dir, 'tasks.json.artifacts'))).toBe(false)
  })

  it('copies a decide ref and warns doctor about temp paths on active tasks', () => {
    seed(task(1, { status: 'open' }))
    const source = join(dir, 'choice.txt')
    writeFileSync(source, 'because')
    const decided = cli('decide', '1', '--summary', 'keep it', '--ref', source, '--by', 'lead')
    expect(decided.status, decided.stderr).toBe(0)
    expect(byId(1).decisions?.[0]?.ref?.replaceAll('\\', '/')).toMatch(
      /tasks\.json\.artifacts\/1\/[0-9a-f]{12}\/choice\.txt$/,
    )
    seed(
      task(1, { evidence: ['/tmp/gone.txt'] }),
      task(2, {
        status: 'claimed',
        owner: 'me',
        decisions: [
          { at: '2026-01-01T00:00:00.000Z', kind: 'choice', summary: 'x', ref: '/private/tmp/a.png', by: 'me' },
        ],
      }),
      task(3, { status: 'done', evidence: ['/tmp/old.txt'] }),
      task(4, { evidence: ['https://example.com/a'] }),
    )
    const report = cli('doctor')
    expect(report.status).toBe(0)
    const hits = report.json.findings.filter((item: { code: string }) => item.code === 'volatile-evidence')
    expect(hits.map((item: { id: number }) => item.id).sort()).toEqual([1, 2])
    expect(hits.every((item: { level: string }) => item.level === 'warn')).toBe(true)
  })
})

describe('owner thread', () => {
  const kinds = (id: number) => (byId(id).decisions ?? []).map((entry) => entry.kind)
  const blockerNames = (id: number) => doneBlockers(byId(id)).map((blocker: string) => blocker.split(':')[0])
  const claimedTask = (id: number, over: Partial<Task> = {}) =>
    task(id, { status: 'claimed', owner: 'w1', claimedAt: hoursAgo(1), ...over })

  it('a question waits on the owner, then on the worker reading the answer, and blocks done throughout', () => {
    seed(claimedTask(1))
    expect(cli('ask-owner', '1', 'which', 'color?', '--by', 'w1').status).toBe(0)
    expect(byId(1).decisions?.at(-1)).toMatchObject({ kind: 'owner-ask', by: 'w1', text: 'which color?' })
    expect(cli('ask-owner', '1', 'again', '--by', 'w1').stderr).toContain('ask-owner needs NoAsk')
    expect(cli('done', '1', '--owner', 'w1').stderr).toContain('NeverDoneOverYourQuestion')
    expect(cli('inbox').json.owner.map((row: { id: number }) => row.id)).toEqual([1])

    expect(cli('answer', '1', 'blue', '--by', 'owner-person').status).toBe(0)
    expect(cli('done', '1', '--owner', 'w1').stderr).toContain('NeverDoneOverUnreadAnswer')
    expect(cli('inbox').json.worker[0]).toMatchObject({ id: 1, answerText: 'blue' })

    expect(cli('answer-read', '1', '--by', 'w1').status).toBe(0)
    expect(cli('done', '1', '--owner', 'w1').status).toBe(0)
    expect(kinds(1)).toEqual(['owner-ask', 'owner-answer', 'answer-read'])
  })

  it('a question handed to the lead waits on the lead reply, and the note waits on the lead too', () => {
    seed(claimedTask(1))
    cli('ask-owner', '1', 'ship it?', '--by', 'w1')
    expect(cli('note', '1', 'lead, your call', '--by', 'owner-person').status).toBe(0)
    expect(blockerNames(1)).toEqual(['NeverDoneOverHandoff', 'NeverDoneOverNote'])
    expect(cli('answer', '1', 'yes', '--by', 'owner-person').stderr).toContain('answer needs Asked')
    expect(cli('inbox').json.lead[0]).toMatchObject({ id: 1, question: 'HandedToLead', noteText: 'lead, your call' })

    expect(cli('note-read', '1', '--by', 'lead').status).toBe(0)
    expect(blockerNames(1)).toEqual(['NeverDoneOverHandoff', 'NeverDoneOverNote'])
    expect(cli('lead-reply', '1', 'ship', 'it', '--by', 'lead').status).toBe(0)
    expect(blockerNames(1)).toEqual(['NeverDoneOverUnreadAnswer'])
    expect(cli('inbox').json.worker[0]).toMatchObject({ answerText: 'ship it' })
    cli('answer-read', '1', '--by', 'w1')
    expect(blockerNames(1)).toEqual([])
  })

  it('a note on a done or cancelled task reopens it for the lead', () => {
    seed(task(1, { status: 'done', doneAt: hoursAgo(2) }), task(2, { status: 'cancelled' }))
    for (const id of ['1', '2']) expect(cli('note', id, 'this is not finished', '--by', 'owner-person').status).toBe(0)
    expect(byId(1)).toMatchObject({ status: 'open', owner: null })
    expect(byId(1).doneAt).toBeUndefined()
    expect(byId(1).decisions?.at(-1)).toMatchObject({ kind: 'note', reopened: 'done' })
    expect(byId(2).decisions?.at(-1)).toMatchObject({ kind: 'note', reopened: 'cancelled' })
    expect(cli('inbox').json.lead.map((row: { id: number }) => row.id)).toEqual([1, 2])
  })

  it('cancel waits for an unread note, journals itself, and ends an open question', () => {
    seed(claimedTask(1))
    cli('ask-owner', '1', 'still needed?', '--by', 'w1')
    cli('note', '1', 'check with me first', '--by', 'owner-person')
    expect(cli('cancel', '1').stderr).toContain('unread note')
    expect(byId(1).status).toBe('claimed')
    cli('note-read', '1', '--by', 'lead')
    expect(cli('cancel', '1').status).toBe(0)
    expect(kinds(1).at(-1)).toBe('cancel')
    expect(cli('cancel', '1').status).toBe(0)
    expect(kinds(1).filter((kind) => kind === 'cancel')).toHaveLength(1)
    expect(cli('inbox').json.lead[0]).toMatchObject({ id: 1, question: 'NoAsk', note: 'NoteRead' })
  })

  it('refuses a missing --by, a reserved --by, blank or flag-like text, and moves out of order', () => {
    seed(claimedTask(1), task(2))
    expect(cli('ask-owner', '1', 'x').stderr).toContain('usage: ask-owner')
    expect(cli('ask-owner', '1', 'x', '--by', 'jev').stderr).toContain('reserved')
    expect(cli('ask-owner', '1', '--by', 'w1').stderr).toContain('usage: ask-owner')
    expect(cli('ask-owner', '1', '--x', '--by', 'w1').stderr).toContain('ask-owner takes no --x')
    expect(cli('ask-owner', '2', 'x', '--by', 'w1').stderr).toContain('only a claimed task')
    expect(cli('note-read', '1', '--by', 'lead').stderr).toContain('note-read needs NoteQueued')
    expect(cli('lead-reply', '1', 'x', '--by', 'lead').stderr).toContain('no handed question and no note')
    expect(cli('answer-read', '1', '--by', 'w1').stderr).toContain('answer-read needs Answered')
    expect(kinds(1)).toEqual([])
  })

  it('a note that reopens finished work voids its confirmation, so the next claim needs a fresh check', () => {
    const confirmed = judgment({ evidence: ['a.png'] }) as unknown as DecisionRecord
    seed(task(1, { status: 'done', doneAt: hoursAgo(2), accept: 'whole', evidence: ['a.png'], decisions: [confirmed] }))
    cli('note', '1', 'the screen is still red', '--by', 'owner-person')
    cli('note-read', '1', '--by', 'lead')
    cli('lead-reply', '1', 'reopened for a fix', '--by', 'lead')
    expect(cli('claim', 'ux-worker', 'w1', '--id', '1').status).toBe(0)
    expect(cli('done', '1', '--owner', 'w1').stderr).toContain('NeverDoneUnconfirmed')
  })

  it('only the owner answers: the claim owner and the asker cannot answer themselves', () => {
    seed(claimedTask(1))
    cli('ask-owner', '1', 'which?', '--by', 'lead')
    expect(cli('answer', '1', 'mine', '--by', 'w1').stderr).toContain('must differ from the task owner')
    expect(cli('answer', '1', 'mine', '--by', 'lead').stderr).toContain('must differ from the task owner')
    expect(cli('answer', '1', 'this one', '--by', 'owner-person').status).toBe(0)
  })

  it('thread text passes the title guard, and a read takes no text', () => {
    seed(claimedTask(1))
    expect(cli('ask-owner', '1', 'x'.repeat(4001), '--by', 'w1').stderr).toContain('over 4000 characters')
    expect(cli('ask-owner', '1', 'key', 'sk-abcdefghijklmnopqrstuv', '--by', 'w1').stderr).toContain('an API key')
    const zeroWidth = String.fromCodePoint(0x200b)
    expect(cli('ask-owner', '1', zeroWidth, '--by', 'w1').stderr).toContain('usage: ask-owner')
    cli('note', '1', 'fyi', '--by', 'owner-person')
    expect(cli('note-read', '1', 'these', 'words', '--by', 'lead').stderr).toContain('usage: note-read')
    expect(kinds(1)).toEqual(['note'])
  })

  it('archive keeps a cancelled task whose note still owes the owner a reply', () => {
    seed(claimedTask(1))
    cli('note', '1', 'why cancel?', '--by', 'owner-person')
    cli('note-read', '1', '--by', 'lead')
    cli('cancel', '1')
    cli('archive', '--older-than-days', '7')
    expect(byId(1)).toMatchObject({ status: 'cancelled' })
    expect((byId(1) as { archived?: boolean }).archived).toBeUndefined()
    cli('lead-reply', '1', 'superseded by 2', '--by', 'lead')
    cli('archive', '--older-than-days', '7')
    expect((byId(1) as { archived?: boolean }).archived).toBeUndefined()
    const saved = JSON.parse(readFileSync(board, 'utf8'))
    saved.tasks[0].deliveries[0].state = 'failed'
    writeFileSync(board, JSON.stringify(saved))
    cli('archive', '--older-than-days', '7')
    expect((byId(1) as { archived?: boolean }).archived).toBe(true)
  })

  it('never touches the evidence gate on a claim: an answer or a note neither voids nor confirms a check', () => {
    const confirmed = judgment({ evidence: ['a.png'] }) as unknown as DecisionRecord
    seed(claimedTask(1, { accept: 'whole', evidence: ['a.png'], decisions: [confirmed] }))
    cli('ask-owner', '1', 'ok?', '--by', 'w1')
    cli('answer', '1', 'yes', '--by', 'owner-person')
    cli('answer-read', '1', '--by', 'w1')
    cli('note', '1', 'fyi', '--by', 'owner-person')
    cli('note-read', '1', '--by', 'lead')
    cli('lead-reply', '1', 'noted', '--by', 'lead')
    expect(blockerNames(1)).toEqual([])
    expect(cli('done', '1', '--owner', 'w1').status).toBe(0)
  })
})

// #2301: the delivery record is written in the same locked board write as the accept decision.
describe('accept queues a delivery', () => {
  interface DeliveryRecord {
    id: string
    entryKind: string
    audience: { kind: string }
    state: string
  }
  const deliveriesOf = (value: unknown) => ((value as { deliveries?: DeliveryRecord[] }).deliveries ?? []).slice()

  it('prints the task and leaves the delivery record in the board file for a claimed, held task', () => {
    seed(task(1, { status: 'open', accept: 'labels fit', owner: null }))
    expect(cli('claim', 'ux-worker', 'worker', '--id', '1', '--wake', 'thread:worker').status).toBe(0)
    expect(cli('evidence', '1', 'a.png').status).toBe(0)
    expect(cli('judgment', '1', JSON.stringify(judgment({ outcome: 'hold', answer: null }))).status).toBe(0)
    const accepted = cli('accept', '1', '--reason', 'read it', '--by', 'owner')
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.json).toMatchObject({ id: 1, status: 'claimed', owner: 'worker' })
    expect(byId(1).decisions?.at(-1)).toMatchObject({ kind: 'accept', by: 'owner', reason: 'read it' })
    const records = deliveriesOf(byId(1))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: '1-d1', entryKind: 'accept', audience: { kind: 'claim' }, state: 'pending' })
    expect(deliveriesOf(accepted.json)).toEqual(records)
  })
})
