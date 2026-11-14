// A scratch board built with the real board CLI, for the unit tests and the browser check. It never touches the
// owner's board: every call names its own TEAM_TASKS_FILE.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This checkout's board CLI. The app under test is pointed at it with TEAM_BOARD_CLI. */
export const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/team-tasks.mjs')

/** Run the CLI against a board file and return what it printed. */
export function cli(file: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, TEAM_TASKS_FILE: file },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** The CLI's JSON output, for the commands that print a record. */
export const cliJson = <T = Record<string, unknown>>(file: string, args: string[]): T =>
  JSON.parse(cli(file, args)) as T

/** Add a task and return its id. Every role but `lead` must say how it is accepted. */
export function addTask(
  file: string,
  role: string,
  title: string,
  options: { tag?: string; after?: number } = {},
): number {
  const args = ['add', role, title]
  if (role !== 'lead') args.push('--accept', `${title} works`)
  if (options.tag) args.push('--tag', options.tag)
  if (options.after !== undefined) args.push('--after', String(options.after))
  return cliJson<{ id: number }>(file, args).id
}

export function claimTask(file: string, role: string, owner: string, id: number): void {
  cli(file, ['claim', role, owner, '--id', String(id)])
}

export type Seed = {
  file: string
  /** Open tasks, in id order. */
  open: number[]
  /** Claimed tasks, in id order. */
  claimed: number[]
  done: number[]
  cancelled: number[]
  /** The open task that waits on the first one. */
  waiting: number
  /** The claimed task whose worker has asked the owner a question. */
  asking: number
  /** The claimed task a test can write to without disturbing the rest. */
  quiet: number
}

export const OWNERS = { ux: 'worker-ux', backend: 'worker-backend', path: '/root/study_runtime_qa' } as const

/** A fresh board with a few tasks of each kind and enough closed ones to need a second page. */
export function seedBoard(file: string, options: { closed: number }): Seed {
  rmSync(dirname(file), { recursive: true, force: true })
  mkdirSync(dirname(file), { recursive: true })

  const first = addTask(file, 'ux-worker', 'Tune the tab strip', { tag: 'board' })
  const open = [
    first,
    addTask(file, 'backend-worker', 'Add the events route', { tag: 'server' }),
    addTask(file, 'qa-worker', 'Write the browser check', { tag: 'verify', after: first }),
    addTask(file, 'lead', 'Document the start command', { tag: 'docs' }),
    addTask(file, 'security-worker', 'Audit the request guard', { tag: 'server' }),
    addTask(file, 'perf-worker', 'Profile the card list', { tag: 'board' }),
  ]
  const waiting = open[2] ?? first

  const claimed = [
    addTask(file, 'ux-worker', 'Draw the column heads', { tag: 'board' }),
    addTask(file, 'backend-worker', 'Watch the board file', { tag: 'server' }),
    addTask(file, 'qa-worker', 'Check the filters', { tag: 'verify' }),
  ]
  const [ux, backend, qa] = claimed
  if (ux === undefined || backend === undefined || qa === undefined) throw new Error('seed: claimed tasks missing')
  claimTask(file, 'ux-worker', OWNERS.ux, ux)
  claimTask(file, 'backend-worker', OWNERS.backend, backend)
  claimTask(file, 'qa-worker', OWNERS.path, qa)
  cli(file, ['ask-owner', String(ux), 'Which tab opens first?', '--by', OWNERS.ux])

  // A lead task can be finished without a check, which is the only way to get a done card on a scratch board.
  const done = [
    addTask(file, 'lead', 'Choose the port', { tag: 'docs' }),
    addTask(file, 'lead', 'Choose the palette', { tag: 'docs' }),
  ]
  for (const id of done) {
    claimTask(file, 'lead', 'lead-session', id)
    cli(file, ['done', String(id), '--owner', 'lead-session'])
  }

  const cancelled: number[] = []
  for (let index = 1; index <= options.closed; index++) {
    const id = addTask(file, 'qa-worker', `Retired experiment ${index}`, { tag: 'old' })
    cli(file, ['cancel', String(id)])
    cancelled.push(id)
  }
  return { file, open, claimed, done, cancelled, waiting, asking: ux, quiet: backend }
}

/** A claimed task with a worker thread to wake: the shape a live worker leaves on the board. */
export function addWorkerTask(
  file: string,
  title: string,
  owner: string,
  wake: string | null = 'thread:worker',
): number {
  const id = addTask(file, 'ux-worker', title, { tag: 'board' })
  claimTask(file, 'ux-worker', owner, id)
  if (wake !== null) cli(file, ['heartbeat', String(id), '--owner', owner, '--wake', wake])
  return id
}

/** Give a claimed, gated task a check that held (or was rejected) on its current evidence. */
export function judgeCheck(file: string, id: number, owner: string, outcome: 'hold' | 'rejected'): void {
  const evidence = `https://example.com/evidence-${id}.txt`
  cli(file, ['evidence', String(id), evidence])
  const basis = cliJson<{ decisions?: unknown[] }>(file, ['show', String(id)]).decisions?.length ?? 0
  cli(file, [
    'judgment',
    String(id),
    JSON.stringify({
      by: owner,
      tool: 'check',
      question: 'Does the evidence show the work is done?',
      outcome,
      answer: null,
      p: null,
      confidence: 0.4,
      reasons: ['the log is thin'],
      evidence: [evidence],
      basis,
      requestHash: 'a'.repeat(64),
      receipt: `receipt-${id}`,
    }),
  ])
}

/** Every open and claimed task as the CLI lists it, for a test to compute what a filter should show. */
export function liveTasks(
  file: string,
): { id: number; title: string; role: string; tag?: string; owner: string | null; status: string }[] {
  return cliJson<{ id: number; title: string; role: string; tag?: string; owner: string | null; status: string }[]>(
    file,
    ['list'],
  )
}
