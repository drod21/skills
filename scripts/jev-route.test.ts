import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TypeSafeClient } from '@typesafe-ai/sdk'
import { describe, expect, it } from 'vitest'

import { routeTasks, verdictFrom } from './jev-route.ts'
import {
  askJev,
  buildRequest,
  calibrate,
  decide,
  EXECUTORS,
  QUESTIONS,
  ROLES,
  ROUTES,
  THRESHOLDS,
  type Answers,
  type Check,
  type Role,
} from './jev-route.lib.ts'

const task = { role: 'ux-worker' }

it('reuses a review route only for the same risk, role and live catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-reuse-'))
  let calls = 0
  const client = { systemOne: async () => {
    calls += 1
    return { answers: answers(0, 0, { mechanical: 0.95 }) }
  } } as unknown as Pick<TypeSafeClient, 'systemOne'>
  try {
    const options = { reuse: { dir, risk: 'same-review-risk' }, availability: { available: new Set<string>() }, log: () => {} }
    await routeTasks([{ title: 'Check the initial candidate', ...task }], client, options)
    const [again] = await routeTasks([{ title: 'Recheck the follow-up', ...task }], client, options)
    expect(again?.decision.route).toBe('deterministic_script')
    expect(calls).toBe(1)
    await routeTasks([{ title: 'Recheck', ...task }], client, { ...options, availability: { available: new Set(['codex:example']) } })
    await routeTasks([{ title: 'Recheck', ...task }], client, { ...options, reuse: { dir, risk: 'changed-risk' } })
    await routeTasks([{ title: 'Recheck', role: 'qa-worker' }], client, options)
    expect(calls).toBe(4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Probability mass split between the two levels around the score, unless the test gives it.
function scoreAnswer(score: number, confidence = 0.9, given?: [number, number, number]) {
  const low = Math.floor(score)
  const split = [0, 0, 0]
  split[low] = 1 - (score - low)
  if (low < 2) split[low + 1] = score - low
  const [p0, p1, p2] = given ?? split
  return { score, confidence, probabilities: { '0': p0 ?? 0, '1': p1 ?? 0, '2': p2 ?? 0 } }
}

const answers = (
  scope: number,
  subtlety: number,
  over: {
    scopeConfidence?: number
    subtletyConfidence?: number
    scopeProbabilities?: [number, number, number]
    subtletyProbabilities?: [number, number, number]
    mechanical?: number
    risky?: number
    needsDecision?: number
    roleFits?: number
    owner?: Role
    ownerConfidence?: number
    check?: Check
    checkConfidence?: number
  } = {},
): Answers => ({
  is_mechanical: { noul: over.mechanical ?? 0.1 },
  scope: scoreAnswer(scope, over.scopeConfidence, over.scopeProbabilities),
  subtlety: scoreAnswer(subtlety, over.subtletyConfidence, over.subtletyProbabilities),
  risky: { noul: over.risky ?? 0.05 },
  needs_decision: { noul: over.needsDecision ?? 0.05 },
  role_fits: { noul: over.roleFits ?? 0.95 },
  owner: { choice: over.owner ?? 'ux-worker', confidence: over.ownerConfidence ?? 0.9 },
  check: { choice: over.check ?? 'none', confidence: over.checkConfidence ?? 0.9 },
})

describe('decide', () => {
  it.each([
    [0, 0, 'haiku_fork'],
    [0, 1, 'haiku_fork'],
    [0, 2, 'terra_patch'],
    [1, 0, 'luna_patch'],
    [1, 1, 'grok_patch'],
    [1, 2, 'terra_patch'],
    [2, 0, 'sonnet_patch'],
    [2, 1, 'sonnet_patch'],
    [2, 2, 'terra_patch'],
  ] as const)('routes scope %i and subtlety %i to %s', (scope, subtlety, route) => {
    const d = decide(answers(scope, subtlety), task)
    expect(d.route).toBe(route)
    expect(d.jevRoute).toBe(route)
    expect(d.holds).toEqual([])
  })

  it('rounds a confident score to the nearest level', () => {
    expect(decide(answers(0.4, 1.4), task).route).toBe('haiku_fork')
    expect(decide(answers(0.6, 1.6), task).route).toBe('terra_patch')
  })

  it('widens the executor instead of holding when a score is uncertain', () => {
    const d = decide(answers(0.3, 0.2, { scopeConfidence: 0.3 }), task)
    expect(d.jevRoute).toBe('haiku_fork')
    expect(d.route).toBe('luna_patch')
    expect(d.reasons[0]).toMatch(/scope confidence 0.30 below floor; took the wider level/)
    expect(d.confidence).toBe(0.3)

    const subtle = decide(answers(1, 1.3, { subtletyConfidence: 0.2 }), task)
    expect(subtle.jevRoute).toBe('grok_patch')
    expect(subtle.route).toBe('terra_patch')
  })

  it('widens a split answer whose expected score lands on a whole level', () => {
    const split = decide(answers(1, 1, { subtletyConfidence: 0.3, subtletyProbabilities: [0.5, 0, 0.5] }), task)
    expect(split.jevRoute).toBe('grok_patch')
    expect(split.route).toBe('terra_patch')
  })

  it('keeps the face level when the wider level has little probability', () => {
    const d = decide(answers(1, 1.1, { subtletyConfidence: 0.3 }), task)
    expect(d.route).toBe('grok_patch')
    expect(d.reasons).toEqual([])
  })

  it('reports nothing when an uncertain score is already at its wider level', () => {
    const d = decide(answers(2, 0, { scopeConfidence: 0.2 }), task)
    expect(d.route).toBe('sonnet_patch')
    expect(d.reasons).toEqual([])
  })

  it('sends clearly mechanical, small, straightforward work to a script', () => {
    expect(decide(answers(0, 0, { mechanical: 0.85 }), task).route).toBe('deterministic_script')
    expect(decide(answers(1, 0, { mechanical: 0.85 }), task).route).toBe('deterministic_script')
    expect(decide(answers(0, 0, { mechanical: 0.79 }), task).route).toBe('haiku_fork')
    expect(decide(answers(2, 0, { mechanical: 0.95 }), task).route).toBe('sonnet_patch')
    expect(decide(answers(0, 1, { mechanical: 0.95 }), task).route).toBe('haiku_fork')
  })

  it('holds a change that is risky or undecided, keeping the face-value executor', () => {
    const risky = decide(answers(0, 0, { risky: 0.91 }), task)
    expect(risky.route).toBe('needs_lead')
    expect(risky.jevRoute).toBe('haiku_fork')
    expect(risky.holds).toEqual(['risky'])

    const open = decide(answers(0, 0, { needsDecision: 0.8 }), task)
    expect(open.holds).toEqual(['needs_decision'])
    expect(open.route).toBe('needs_lead')
  })

  it('treats a noul near 0.5 as uncertainty, not a hold', () => {
    const d = decide(answers(0, 0, { risky: 0.5, needsDecision: 0.5 }), task)
    expect(d.route).toBe('haiku_fork')
    expect(d.holds).toEqual([])
  })

  it('suggests another owner without changing the route, and adopts it only when confident', () => {
    const d = decide(answers(0, 0, { roleFits: 0.1, owner: 'backend-worker', ownerConfidence: 0.88 }), task)
    expect(d.route).toBe('haiku_fork')
    expect(d.roleFits).toBe(false)
    expect(d.suggestedRole).toBe('backend-worker')
    expect(d.adoptRole).toBe(true)

    const unsure = decide(answers(0, 0, { roleFits: 0.1, owner: 'backend-worker', ownerConfidence: 0.2 }), task)
    expect(unsure.suggestedRole).toBe('backend-worker')
    expect(unsure.adoptRole).toBe(false)
    expect(unsure.reasons).toContain('Jev suggests backend-worker (confidence 0.20)')
  })

  it('holds for the lead instead of adopting lead as a worker role', () => {
    const d = decide(answers(0, 0, { roleFits: 0.1, owner: 'lead', ownerConfidence: 0.8 }), task)
    expect(d.route).toBe('needs_lead')
    expect(d.holds).toEqual(['needs_decision'])
    expect(d.suggestedRole).toBe('lead')
    expect(d.adoptRole).toBe(false)

    const unsure = decide(answers(0, 0, { roleFits: 0.1, owner: 'lead', ownerConfidence: 0.3 }), task)
    expect(unsure.route).toBe('haiku_fork')
    expect(unsure.holds).toEqual([])
  })

  it.each([
    ['a noul outside 0..1', (a: Answers) => ({ ...a, risky: { noul: 1.5 } }), 'risky'],
    ['a missing noul', (a: Answers) => ({ ...a, needs_decision: {} }), 'needs_decision'],
    ['a score without probabilities', (a: Answers) => ({ ...a, scope: { score: 1, confidence: 0.9 } }), 'scope'],
    ['a score above the top level', (a: Answers) => ({ ...a, subtlety: { ...a.subtlety, score: 3 } }), 'subtlety'],
    [
      'an owner outside the role catalog',
      (a: Answers) => ({ ...a, owner: { choice: 'janitor', confidence: 1 } }),
      'owner',
    ],
    ['a check outside the check list', (a: Answers) => ({ ...a, check: { choice: 'vibes', confidence: 1 } }), 'check'],
  ])('refuses %s instead of writing a verdict', (_, broken, field) => {
    const bad = broken(answers(0, 0)) as unknown as Answers
    expect(() => decide(bad, task)).toThrow(new RegExp(`malformed answers for ${field}`))
  })

  it('omits a suggested owner when Jev names the role already assigned', () => {
    const same = decide(answers(0, 0, { roleFits: 0.1, owner: 'ux-worker', ownerConfidence: 0.9 }), task)
    expect(same.suggestedRole).toBeNull()
    expect(same.adoptRole).toBe(false)
  })

  it('keeps a confident check whatever the route, including a held task', () => {
    expect(decide(answers(0, 0, { check: 'focused_test', checkConfidence: 0.8 }), task).check).toBe('focused_test')
    expect(decide(answers(0, 0, { check: 'runtime', checkConfidence: 0.3 }), task).check).toBeNull()
    const held = decide(answers(0, 0, { risky: 0.9, check: 'runtime', checkConfidence: 0.9 }), task)
    expect(held.route).toBe('needs_lead')
    expect(held.check).toBe('runtime')
  })
})

describe('askJev', () => {
  it.each(['specialist-worker', 'security-worker', 'perf-worker'] as const)(
    'offers %s to the routing judge and preserves a confident specialist recommendation',
    (role) => {
      const sample = { title: 'Review specialist evidence', role: 'backend-worker' }
      const request = buildRequest(sample)
      expect(request.state.roles[role]).toBe(ROLES[role])
      expect(decide(answers(1, 2, { roleFits: 0.1, owner: role }), sample)).toMatchObject({
        suggestedRole: role,
        roleFits: false,
      })
    },
  )

  it('sends task state with every question and returns the answers', async () => {
    const sample = { title: 'Fix typo in onboarding copy', role: 'ux-worker', after: [2] }
    const sent: unknown[] = []
    const client = {
      systemOne: async (request: unknown) => (sent.push(request), { answers: answers(0, 0) }),
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await expect(askJev(client, sample)).resolves.toMatchObject({ scope: { score: 0 } })
    expect(sent).toEqual([buildRequest(sample)])
    expect(buildRequest(sample).state.task).toEqual({ title: sample.title, role: 'ux-worker', dependsOn: [2] })
    expect(Object.keys(buildRequest(sample).questions)).toEqual([
      'is_mechanical',
      'scope',
      'subtlety',
      'risky',
      'needs_decision',
      'role_fits',
      'owner',
      'check',
    ])
  })

  it('sends the brief and resolved dependencies in place of bare ids', () => {
    const request = buildRequest({
      title: 'Wire the new route',
      role: 'backend-worker',
      after: [3],
      brief: '  Allowed: apps/server/src/routes/x.ts. Acceptance: x.test.ts passes.  ',
      dependencies: [{ id: 3, title: 'Add the schema', status: 'done' }],
    })
    expect(request.state.task).toEqual({
      title: 'Wire the new route',
      role: 'backend-worker',
      brief: 'Allowed: apps/server/src/routes/x.ts. Acceptance: x.test.ts passes.',
      dependsOn: [{ id: 3, title: 'Add the schema', status: 'done' }],
    })
  })
})

describe('route vocabulary', () => {
  it('only emits routes the board accepts', () => {
    const emitted = new Set([...Object.values(EXECUTORS).flat(), 'deterministic_script', 'needs_lead'])
    for (const route of emitted) expect(ROUTES).toContain(route)
  })

  it('asks no executor question', () => {
    expect(Object.keys(QUESTIONS)).not.toContain('route')
  })
})

describe('recording a verdict on the board', () => {
  const boardFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-route-'))
    return join(dir, 'tasks.json')
  }

  const execOn = (file: string, calls: string[][]) => (script: string, args: string[]) => {
    calls.push(args)
    execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, TEAM_TASKS_FILE: file },
      stdio: 'pipe',
    })
  }

  const tasksOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')).tasks

  it('passes --jev to team-tasks add and stores the stamped verdict with its answers', async () => {
    const file = boardFile()
    const existing = [{ id: 4, role: 'ux-worker', title: 'done', status: 'done', owner: null, after: [], route: null }]
    writeFileSync(file, JSON.stringify({ version: 1, tasks: existing }))
    const calls: string[][] = []
    const seen: unknown[] = []
    const recording = {
      systemOne: async (request: { state?: { task?: unknown } }) => {
        seen.push(request.state?.task)
        return { answers: answers(0, 0, { check: 'focused_test', checkConfidence: 0.8 }) }
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    const [result] = await routeTasks([{ title: 'Fix typo', role: 'ux-worker', after: [4] }], recording, {
      add: true,
      accept: 'The typo is gone',
      exec: execOn(file, calls),
      readTasks: () => existing,
      log: () => {},
    })
    expect(seen[0]).toMatchObject({ dependsOn: [{ id: 4, title: 'done', status: 'done' }] })
    expect(calls[0]?.slice(0, 3)).toEqual(['add', 'ux-worker', 'Fix typo'])
    expect(calls[0]).toEqual(expect.arrayContaining(['--after', '4', '--route', 'haiku_fork', '--jev']))
    const jevArg = calls[0]![calls[0]!.indexOf('--jev') + 1]!
    expect(JSON.parse(jevArg)).toEqual(result!.verdict)
    expect(result!.verdict).not.toHaveProperty('at')
    const stored = tasksOf(file).find((task: { title: string }) => task.title === 'Fix typo')
    expect(stored).toMatchObject({
      route: 'haiku_fork',
      after: [4],
      jev: { route: 'haiku_fork', jevRoute: 'haiku_fork', confidence: 0.9, check: 'focused_test' },
    })
    expect(stored.jev.answers.scope).toEqual({ score: 0, confidence: 0.9, probabilities: { '0': 1, '1': 0, '2': 0 } })
    expect(stored.jev.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('adds the task under the role Jev is confident about', async () => {
    const file = boardFile()
    const calls: string[][] = []
    const lines: string[] = []
    const misassigned = {
      systemOne: async () => ({
        answers: answers(1, 1, { roleFits: 0.1, owner: 'backend-worker', ownerConfidence: 0.8 }),
      }),
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    const [result] = await routeTasks([{ title: 'Add the sessions index', role: 'ux-worker' }], misassigned, {
      add: true,
      accept: 'The index exists',
      exec: execOn(file, calls),
      readTasks: () => [],
      log: (line) => lines.push(line),
    })
    expect(result!.role).toBe('backend-worker')
    expect(calls[0]?.slice(0, 2)).toEqual(['add', 'backend-worker'])
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ role: 'backend-worker', suggestedRole: 'backend-worker' })
    expect(tasksOf(file)[0]).toMatchObject({ role: 'backend-worker', jev: { roleFits: false } })
  })

  it('keeps the submitted role when Jev is unsure who owns it', async () => {
    const calls: string[][] = []
    const unsure = {
      systemOne: async () => ({
        answers: answers(1, 1, { roleFits: 0.1, owner: 'backend-worker', ownerConfidence: 0.3 }),
      }),
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await routeTasks([{ title: 'Add the sessions index', role: 'ux-worker' }], unsure, {
      add: true,
      accept: 'The index exists',
      exec: (_script, args) => void calls.push(args),
      readTasks: () => [],
      log: () => {},
    })
    expect(calls[0]?.slice(0, 2)).toEqual(['add', 'ux-worker'])
  })

  it('refuses a brief over the cap before asking Jev', async () => {
    const asking = {
      systemOne: async () => {
        throw new Error('should not ask')
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await expect(
      routeTasks([{ title: 'x', role: 'ux-worker', brief: 'a'.repeat(4001) }], asking, { readTasks: () => [] }),
    ).rejects.toThrow('brief is over 4000 characters')
  })

  const refusing = {
    systemOne: async () => {
      throw new Error('should not ask')
    },
  } as unknown as Pick<TypeSafeClient, 'systemOne'>

  it.each([
    ['an email in the brief', { brief: 'Ask someone@example.com for the fixture' }, 'brief contains an email address'],
    ['an email in the title', { title: 'Mail someone@example.com' }, 'title contains an email address'],
    ['a number dump in the brief', { brief: Array.from({ length: 30 }, (_, i) => i).join(' ') }, 'long run of numbers'],
  ])('refuses %s before asking Jev', async (_, over, message) => {
    const subject = { title: 'Fix typo', role: 'ux-worker', ...over }
    await expect(routeTasks([subject], refusing, { readTasks: () => [] })).rejects.toThrow(message)
  })

  it('refuses a request that carries the API key', async () => {
    const saved = process.env.TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = 'sk-test-route-key'
    try {
      const subject = { title: 'Fix typo', role: 'ux-worker', brief: 'Use sk-test-route-key here' }
      await expect(routeTasks([subject], refusing, { readTasks: () => [] })).rejects.toThrow(
        'input contains the API key',
      )
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = saved
    }
  })

  it('withholds a dependency title that fails the text check instead of sending it', async () => {
    const seen: unknown[] = []
    const recording = {
      systemOne: async (request: { state?: { task?: unknown } }) => {
        seen.push(request.state?.task)
        return { answers: answers(0, 0) }
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    const board = [{ id: 7, title: 'Reply to someone@example.com', status: 'open' }]
    await routeTasks([{ title: 'Fix typo', role: 'ux-worker', after: [7] }], recording, {
      readTasks: () => board,
      log: () => {},
    })
    expect(seen[0]).toMatchObject({ dependsOn: [{ id: 7, title: 'withheld: failed the text check' }] })
  })

  it('reads the board only for --task or a task with dependencies', async () => {
    let reads = 0
    const client = { systemOne: async () => ({ answers: answers(0, 0) }) } as unknown as Pick<
      TypeSafeClient,
      'systemOne'
    >
    const readTasks = () => {
      reads += 1
      return []
    }
    await routeTasks([{ title: 'Fix typo', role: 'ux-worker' }], client, { readTasks, log: () => {} })
    expect(reads).toBe(0)
    await routeTasks([{ title: 'Fix typo', role: 'ux-worker', after: [3] }], client, { readTasks, log: () => {} })
    expect(reads).toBe(1)
  })

  it('calls team-tasks jev for an existing task and reads its title, role, and dependencies from the board', async () => {
    const file = boardFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 4,
            role: 'backend-worker',
            title: 'Add the schema',
            status: 'done',
            owner: 'a',
            after: [],
            route: null,
          },
          { id: 7, role: 'ux-worker', title: 'held', status: 'open', owner: null, after: [4], route: 'needs_lead' },
        ],
      }),
    )
    const previous = process.env.TEAM_TASKS_FILE
    process.env.TEAM_TASKS_FILE = file
    const calls: string[][] = []
    const lines: string[] = []
    const seen: unknown[] = []
    const recording = {
      systemOne: async (request: { state?: { task?: unknown } }) => {
        seen.push(request.state?.task)
        return { answers: answers(0, 0, { check: 'focused_test', checkConfidence: 0.8 }) }
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    try {
      await routeTasks([{ title: 'from-cli', role: 'qa-worker' }], recording, {
        taskId: '7',
        brief: 'Acceptance: the held screen renders.',
        exec: execOn(file, calls),
        log: (line) => lines.push(line),
      })
    } finally {
      if (previous === undefined) delete process.env.TEAM_TASKS_FILE
      else process.env.TEAM_TASKS_FILE = previous
    }
    expect(seen[0]).toEqual({
      title: 'held',
      role: 'ux-worker',
      brief: 'Acceptance: the held screen renders.',
      dependsOn: [{ id: 4, title: 'Add the schema', status: 'done' }],
    })
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ title: 'held', role: 'ux-worker' })
    expect(calls[0]?.[0]).toBe('jev')
    expect(calls[0]?.[1]).toBe('7')
    const held = tasksOf(file).find((task: { id: number }) => task.id === 7)
    expect(held).toMatchObject({ route: 'needs_lead', jev: { jevRoute: 'haiku_fork', confidence: 0.9 } })
    expect(held).not.toHaveProperty('note')
  })

  it('a symlinked invocation prints usage and does not call Jev', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-link-'))
    const link = join(dir, 'jev-route.ts')
    symlinkSync(join(import.meta.dirname, 'jev-route.ts'), link)
    const result = spawnSync(process.execPath, [link], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('usage:')
  })

  it('reports a missing --task before a missing API key', () => {
    const file = boardFile()
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [] }))
    const env = { ...process.env, TEAM_TASKS_FILE: file }
    delete env.TYPESAFE_API_KEY
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'jev-route.ts'), '--task', '42'], {
      encoding: 'utf8',
      env,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('task 42 does not exist')
  })

  it('reads a board whose task list is larger than the default child-process buffer', () => {
    const file = boardFile()
    const padding = 'x'.repeat(4096)
    const tasks = Array.from({ length: 600 }, (_, index) => ({
      id: index + 1,
      role: 'ux-worker',
      title: `finished ${index + 1}`,
      status: 'done',
      owner: null,
      after: [],
      route: null,
      evidence: [padding],
    }))
    writeFileSync(file, JSON.stringify({ version: 1, tasks }))
    const env = { ...process.env, TEAM_TASKS_FILE: file }
    delete env.TYPESAFE_API_KEY
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'jev-route.ts'), '--task', '9999'], {
      encoding: 'utf8',
      env,
    })
    expect(result.stderr).not.toContain('ENOBUFS')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('task 9999 does not exist')
  })

  it('refuses a --brief with no value or another flag as its value', () => {
    const script = join(import.meta.dirname, 'jev-route.ts')
    for (const args of [
      ['A title', '--role', 'ux-worker', '--brief', '--add'],
      ['A title', '--role', 'ux-worker', '--brief'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
      expect(result.status, args.join(' ')).toBe(1)
      expect(result.stderr, args.join(' ')).toContain('--brief needs a text value')
    }
  })

  it('rejects a missing or invalid --task, or a CLI title or role, before calling Jev', () => {
    const script = join(import.meta.dirname, 'jev-route.ts')
    for (const args of [
      ['--task'],
      ['--task', '0'],
      ['--task', 'nope'],
      ['A title', '--task', '1'],
      ['--role', 'ux-worker', '--task', '1'],
      ['--after', '4', '--task', '1'],
      ['--add', '--task', '1'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
      expect(result.status, args.join(' ')).toBe(1)
      expect(`${result.stdout}${result.stderr}`, args.join(' ')).toMatch(/--task|usage:|--add/)
      expect(`${result.stdout}${result.stderr}`).not.toContain('TYPESAFE')
    }
  })

  it('refuses a done or cancelled --task before calling Jev', async () => {
    const file = boardFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          { id: 1, role: 'ux-worker', title: 'finished', status: 'done', owner: 'me', after: [], route: 'haiku_fork' },
          { id: 2, role: 'ux-worker', title: 'dropped', status: 'cancelled', owner: null, after: [], route: null },
        ],
      }),
    )
    const before = readFileSync(file, 'utf8')
    const previous = process.env.TEAM_TASKS_FILE
    process.env.TEAM_TASKS_FILE = file
    const asking = {
      systemOne: async () => {
        throw new Error('should not ask')
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    try {
      await expect(routeTasks([{ title: 'cli', role: 'qa-worker' }], asking, { taskId: '1' })).rejects.toThrow(
        'task 1 is done; a done or cancelled task cannot take a verdict',
      )
      await expect(routeTasks([{ title: 'cli', role: 'qa-worker' }], asking, { taskId: '2' })).rejects.toThrow(
        'task 2 is cancelled; a done or cancelled task cannot take a verdict',
      )
    } finally {
      if (previous === undefined) delete process.env.TEAM_TASKS_FILE
      else process.env.TEAM_TASKS_FILE = previous
    }
    const script = join(import.meta.dirname, 'jev-route.ts')
    for (const [id, status] of [
      ['1', 'done'],
      ['2', 'cancelled'],
    ] as const) {
      const result = spawnSync(process.execPath, [script, '--task', id], {
        encoding: 'utf8',
        env: { ...process.env, TEAM_TASKS_FILE: file },
      })
      expect(result.status, id).toBe(1)
      expect(result.stderr).toContain(`task ${id} is ${status}; a done or cancelled task cannot take a verdict`)
      expect(result.stderr).not.toContain('TYPESAFE')
      expect(result.stderr).not.toContain('at routeTasks')
      expect(result.stderr).not.toMatch(/\n\s+at /)
    }
    const missing = spawnSync(process.execPath, [script, '--task', '9'], {
      encoding: 'utf8',
      env: { ...process.env, TEAM_TASKS_FILE: file },
    })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('task 9 does not exist')
    expect(missing.stderr).not.toContain('TYPESAFE')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses --add together with --task before asking Jev', async () => {
    const asking = {
      systemOne: async () => {
        throw new Error('should not ask')
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await expect(routeTasks([{ title: 'x', role: 'ux-worker' }], asking, { add: true, taskId: '1' })).rejects.toThrow(
      '--add and --task',
    )
  })

  it('refuses --task when more than one task is given', async () => {
    const asking = {
      systemOne: async () => {
        throw new Error('should not ask')
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await expect(
      routeTasks(
        [
          { title: 'a', role: 'ux-worker' },
          { title: 'b', role: 'ux-worker' },
        ],
        asking,
        { taskId: '1' },
      ),
    ).rejects.toThrow('exactly one')
  })

  it('sends --accept to Jev and passes --accept and --tag through to add', async () => {
    const file = boardFile()
    const calls: string[][] = []
    const seen: unknown[] = []
    const recording = {
      systemOne: async (request: { state?: { task?: unknown } }) => {
        seen.push(request.state?.task)
        return { answers: answers(0, 0) }
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await routeTasks([{ title: 'Fix the label', role: 'ux-worker' }], recording, {
      add: true,
      accept: 'The full label is visible',
      tag: 'wizard-1276',
      exec: execOn(file, calls),
      readTasks: () => [],
      log: () => {},
    })
    expect(seen[0]).toMatchObject({ accept: 'The full label is visible' })
    expect(calls[0]).toEqual(expect.arrayContaining(['--accept', 'The full label is visible', '--tag', 'wizard-1276']))
    expect(tasksOf(file)[0]).toMatchObject({ accept: 'The full label is visible', tag: 'wizard-1276' })
  })

  it('refuses --add without --accept for a non-lead role before asking Jev', async () => {
    const asking = {
      systemOne: async () => {
        throw new Error('should not ask')
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    await expect(routeTasks([{ title: 'x', role: 'ux-worker' }], asking, { add: true })).rejects.toThrow('--accept')
    await expect(
      routeTasks([{ title: 'x', role: 'watch-camera-runtime', accept: 'y' }], asking, { add: true }),
    ).rejects.toThrow('--tag watch')
    const fileRole = [{ title: 'x', role: ['lead'] as unknown as string, accept: 'y' }]
    await expect(routeTasks(fileRole, asking, { add: true })).rejects.toThrow('no role was given')
    // No --role: Jev is still asked, so it can pick the owner.
    await expect(routeTasks([{ title: 'x', role: 'unassigned', accept: 'y' }], asking, { add: true })).rejects.toThrow(
      'should not ask',
    )
    await expect(routeTasks([{ title: 'x', role: 'lead' }], asking, { add: true, tag: 'No' })).rejects.toThrow('--tag')
    const two = [
      { title: 'a', role: 'ux-worker' },
      { title: 'b', role: 'ux-worker' },
    ]
    await expect(routeTasks(two, asking, { add: true, accept: 'one check' })).rejects.toThrow('applies to one task')
    const oneMissing = [
      { title: 'a', role: 'ux-worker', accept: 'a works' },
      { title: 'b', role: 'qa-worker' },
    ]
    await expect(routeTasks(oneMissing, asking, { add: true })).rejects.toThrow('qa-worker')
  })

  it('adds each task of a batch with its own accept', async () => {
    const file = boardFile()
    const calls: string[][] = []
    const client = {
      systemOne: async () => ({ answers: answers(0, 0) }),
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    const batch = [
      { title: 'Fix the label', role: 'ux-worker', accept: 'the label is whole' },
      { title: 'Test the label', role: 'qa-worker', accept: 'a test covers it' },
    ]
    await routeTasks(batch, client, { add: true, exec: execOn(file, calls), readTasks: () => [], log: () => {} })
    expect(tasksOf(file).map((task: { accept?: string }) => task.accept)).toEqual([
      'the label is whole',
      'a test covers it',
    ])
  })

  it('verdictFrom keeps the fields the board stores plus the raw answers', () => {
    const sample = answers(0, 0, { check: 'focused_test', checkConfidence: 0.8 })
    const verdict = verdictFrom(decide(sample, task), sample)
    expect(Object.keys(verdict).sort()).toEqual([
      'answers',
      'check',
      'confidence',
      'executor',
      'holds',
      'jevRoute',
      'reasons',
      'roleFits',
      'route',
      'suggestedRole',
    ])
    expect(verdict.executor).toBeNull()
    expect(verdict.answers).toBe(sample)
  })
})

describe('help', () => {
  it('prints the usage for --help and -h and asks Jev nothing', () => {
    const env = { ...process.env }
    delete env.TYPESAFE_API_KEY
    for (const flag of ['--help', '-h']) {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, 'jev-route.ts'), flag], { encoding: 'utf8', env })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('usage: node scripts/jev-route.ts')
    }
  })
})

describe('calibrate', () => {
  const row = (route: string, answer: Answers | undefined, jevRoute = route) => ({
    role: 'ux-worker',
    route,
    jev: answer === undefined ? { route: jevRoute } : { route: jevRoute, answers: answer },
  })

  it('counts legacy and unreadable rows, and names no change below 30', () => {
    const before = { ...THRESHOLDS }
    const report = calibrate([
      row('haiku_fork', answers(0, 0)),
      row('haiku_fork', undefined),
      { role: 'ux-worker', route: 'haiku_fork', jev: null },
      { role: 'ux-worker', route: 'haiku_fork', jev: { answers: { is_mechanical: { noul: 2 } } } },
      row('lead_workflow', answers(0, 0)),
      row('sonnet_patch', answers(0, 0), 'sonnet_patch'),
    ])
    expect(THRESHOLDS).toEqual(before)
    expect(report).toMatchObject({
      withAnswers: 3,
      rows: 3,
      legacyWithoutAnswers: 2,
      unreadable: 1,
      notAJevRoute: 1,
      finalRouteMatches: 1,
      verdictRouteMatches: 1,
      suggestion: null,
    })
    expect(report.note).toContain('fewer than 30 rows')
    expect(report.confusion).toEqual([
      { final: 'haiku_fork', replayed: 'haiku_fork', count: 1 },
      { final: 'sonnet_patch', replayed: 'haiku_fork', count: 1 },
    ])
    expect(report.sweep.find((point) => point.name === 'minWidenProbability' && point.value === 0.15)).toBeTruthy()
    expect(report.sweep.filter((point) => point.name === 'minHoldNoul').map((point) => point.value)).toEqual([
      0.5, 0.6, 0.7, 0.8, 0.9,
    ])
  })

  it('suggests one knob once 30 readable rows agree on a higher floor', () => {
    const held = answers(0, 0, { risky: 0.75 })
    const tasks = Array.from({ length: 30 }, () => row('haiku_fork', held, 'needs_lead'))
    const report = calibrate(tasks)
    expect(report.finalRouteMatches).toBe(0)
    expect(report.verdictRouteMatches).toBe(30)
    expect(report.note).toBeNull()
    expect(report.suggestion).toEqual({ name: 'minHoldNoul', value: 0.8, finalRouteMatches: 30 })
    expect(calibrate(tasks.slice(0, 29)).suggestion).toBeNull()
    expect(decide(held, { role: 'ux-worker' }, { ...THRESHOLDS, minHoldNoul: 0.9 }).route).toBe('haiku_fork')
  })

  it('reads done tasks from list --all and does not call Jev or write the board', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-calibrate-'))
    const file = join(dir, 'tasks.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 1,
            role: 'ux-worker',
            title: 'old',
            status: 'done',
            owner: 'a',
            after: [],
            route: 'haiku_fork',
            jev: { route: 'haiku_fork', answers: answers(0, 0) },
          },
        ],
      }),
    )
    const before = readFileSync(file, 'utf8')
    const env = { ...process.env, TEAM_TASKS_FILE: file }
    delete env.TYPESAFE_API_KEY
    const script = join(import.meta.dirname, 'jev-route.ts')
    const text = spawnSync(process.execPath, [script, '--calibrate'], { encoding: 'utf8', env })
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).toContain('fewer than 30 rows')
    expect(text.stdout).toContain('final route matches 1')
    expect(text.stderr).not.toContain('TYPESAFE')
    const json = spawnSync(process.execPath, [script, '--calibrate', '--json'], { encoding: 'utf8', env })
    expect(json.status, json.stderr).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({ withAnswers: 1, finalRouteMatches: 1, suggestion: null })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
