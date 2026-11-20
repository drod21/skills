import './jev-node-only.mjs'
// Route agent-team tasks through Jev before dispatch (agent-team step 5).
// Usage: node scripts/jev-route.ts "<title>" --role <role> [--after 3,5] [--brief <text>] [--add]
//        node scripts/jev-route.ts --task <id> [--brief <text>]
//        node scripts/jev-route.ts <tasks.json>          (array of { title, role, after?, brief? })
// --brief adds the worker brief (allowed files, acceptance check) to what Jev reads. Dependency titles
// come from the board. --add appends the task with its route and the verdict (--jev), under Jev's
// suggested role when Jev is confident the submitted role does not fit.
// --task <id> reads that task's title, role, and after from the board. It does not take a CLI title, --role, or --after.
// A done or cancelled task is refused before Jev is called.
// After the route is decided, one more Jev question picks among the route's available executors
// (scripts/jev-executors.lib.ts). --available <file> is a JSON list the lead writes from the harness catalog
// ("providerInstanceId:model" strings or objects); without it every registry executor counts. --unavailable
// <providerInstanceId[:model]> (repeatable) drops a known outage. The printed verdict carries `executor`.
// Needs TYPESAFE_API_KEY.
// Run under Node 22.18+, not Bun: @typesafe-ai/sdk 0.7.0 throws "Body already used" on Bun 1.4.4.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TypeSafeClient } from '@typesafe-ai/sdk'
import { type } from 'arktype'

import {
  askExecutor,
  TIER_EXECUTORS,
  availableFor,
  isTierRoute,
  parseAvailableText,
  pickExecutor,
  readChoice,
  verdictExecutor,
  type Availability,
  type ChoiceAnswer,
  type VerdictExecutor,
} from './jev-executors.lib.ts'
import { assertApiKeyAbsent, cleanText, redactApiKey } from './jev-guard.lib.ts'
import {
  askJev,
  calibrate,
  decide,
  THRESHOLDS,
  type Answers,
  type CalibrationReport,
  type Decision,
  type Dependency,
  type Task,
} from './jev-route.lib.ts'
import { ROLES, unknownRoleMessage } from './team-catalog.mjs'

const USAGE =
  'usage: node scripts/jev-route.ts "<title>" --role <role> [--after 3,5] [--brief <text>] [--accept <text>] [--tag <t>] [--add] | --task <id> [--brief <text>] [--accept <text>] | <tasks.json> | --calibrate [--json]; takes [--available <file.json>] [--unavailable <providerInstanceId[:model]>]...; a standalone route can take --reuse-dir <dir> --reuse-risk <label> with --available'

export function flag(args: string[], name: string) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

/** A valued flag. A missing value or one that is another flag is refused. */
function textFlag(args: string[], name: string) {
  if (!args.includes(name)) return undefined
  const value = flag(args, name)
  if (value === undefined || value.startsWith('--')) throw new Error(`${USAGE}\n${name} needs a text value`)
  return value
}

/** The --brief value. A missing value or one that is another flag is refused, not sent as the brief. */
export function briefFlag(args: string[]) {
  return textFlag(args, '--brief')
}

export function acceptFlag(args: string[]) {
  return textFlag(args, '--accept')
}

export function tagFlag(args: string[]) {
  return textFlag(args, '--tag')
}

/** --available <file> and every --unavailable <providerInstanceId[:model]>. Neither flag means all executors count. */
export function availabilityFlags(args: string[]): Availability | undefined {
  const flagValue = type('string > 0')
    .pipe((text) => text.trim())
    .narrow((text) => text.length > 0 && !text.startsWith('--'))
  const fileValue = args.includes('--available') ? flagValue(flag(args, '--available')) : undefined
  if (fileValue instanceof type.errors) throw new Error('--available needs a text value')
  const file = fileValue
  const unavailable: string[] = []
  args.forEach((arg, index) => {
    if (arg !== '--unavailable') return
    const value = flagValue(args[index + 1])
    if (value instanceof type.errors) throw new Error('--unavailable needs a providerInstanceId[:model]')
    unavailable.push(value)
  })
  if (file === undefined && !unavailable.length) return undefined
  let available: Set<string> | undefined
  if (file !== undefined) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new Error('--available is not readable JSON')
    }
    available = parseAvailableText(text)
  }
  return { ...(available ? { available } : {}), ...(unavailable.length ? { unavailable } : {}) }
}

export function parseTasks(args: string[]): Task[] {
  const [first] = args
  if (!first) throw new Error(USAGE)
  if (first.endsWith('.json')) return JSON.parse(readFileSync(first, 'utf8'))
  const after = flag(args, '--after')?.split(',').filter(Boolean).map(Number)
  const brief = briefFlag(args)
  const accept = acceptFlag(args)
  return [
    {
      title: first,
      role: flag(args, '--role') ?? 'unassigned',
      ...(after ? { after } : {}),
      ...(brief ? { brief } : {}),
      ...(accept ? { accept } : {}),
    },
  ]
}

// Everything Jev reads passes jev-decide's text checks. The title and brief are refused when they fail;
// a dependency title comes from someone else's task, so it is withheld instead of blocking the route.
function checkedText(task: Task): Task {
  const title = cleanText(task.title, 'title')
  const brief = task.brief === undefined ? {} : { brief: cleanText(task.brief, 'brief') }
  const accept = task.accept === undefined ? {} : { accept: cleanText(task.accept, 'accept') }
  return { ...task, title, ...brief, ...accept }
}

function safeDependencyTitle(title: string) {
  try {
    return cleanText(title, 'dependency title')
  } catch {
    return 'withheld: failed the text check'
  }
}

/** The executor chosen for a decided route, with its allow-listed answer for calibration. */
export type ExecutorOutcome = {
  executor: VerdictExecutor | null
  reasons: string[]
  /** Ids offered to Jev; empty when it was not asked. */
  offered: string[]
  answer: ChoiceAnswer | null
}

const NO_EXECUTOR: ExecutorOutcome = { executor: null, reasons: [], offered: [], answer: null }

/**
 * The verdict stored on the board, with Jev's raw answers for recalibration. team-tasks stamps `at`.
 * The executor question's allow-listed answer rides in `answers.executor_pick` when Jev was asked.
 */
export function verdictFrom(decision: Decision, answers: Answers, outcome: ExecutorOutcome = NO_EXECUTOR) {
  const asked = outcome.offered.length >= 2
  return {
    route: decision.route,
    jevRoute: decision.jevRoute,
    confidence: decision.confidence,
    holds: decision.holds,
    roleFits: decision.roleFits,
    suggestedRole: decision.suggestedRole,
    check: decision.check,
    reasons: [...decision.reasons, ...outcome.reasons],
    executor: outcome.executor,
    answers: asked ? { ...answers, executor_pick: { offered: outcome.offered, ...outcome.answer } } : answers,
  }
}

/** Chooses the executor for a decided route. A held, scripted, or non-tier route gets none. */
async function chooseExecutor(
  client: Pick<TypeSafeClient, 'systemOne'>,
  task: Task,
  decision: Decision,
  availability: Availability | undefined,
  cachedPick?: { answer: ChoiceAnswer | null },
): Promise<ExecutorOutcome> {
  if (decision.holds.length || !isTierRoute(decision.route)) return NO_EXECUTOR
  const offered = availableFor(decision.route, availability)
  const reused = cachedPick && readChoice(cachedPick.answer, offered)
  const { pick, answer } = cachedPick
    ? { pick: pickExecutor(decision.route, offered, reused ?? null, THRESHOLDS.minExecutorConfidence), answer: reused ?? null }
    : await askExecutor(client, task, decision.route, offered, THRESHOLDS.minExecutorConfidence)
  return {
    executor: verdictExecutor(pick),
    reasons: pick.reasons,
    offered: offered.map((entry) => entry.id),
    answer,
  }
}

export type BoardExec = (script: string, args: string[]) => void
type BoardTask = { id?: number; title?: string; role?: string; after?: number[]; status?: string }

type RouteOptions = {
  add?: boolean
  taskId?: string
  brief?: string
  accept?: string
  tag?: string
  /** The executors the lead's harness offers; absent means every registry executor. */
  availability?: Availability
  reuse?: { dir: string; risk: string }
  boardScript?: string
  exec?: BoardExec
  readTasks?: () => BoardTask[]
  log?: (line: string) => void
}

function refuseMixedRouteFlags(options: RouteOptions, count: number) {
  if (options.add && options.taskId) throw new Error('--add and --task cannot be used together')
  if (options.taskId && count !== 1) throw new Error('--task routes exactly one existing task')
}

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

function refuseAddWithoutAccept(tasks: Task[], options: RouteOptions) {
  if (options.tag !== undefined && !TAG_PATTERN.test(options.tag.trim()))
    throw new Error('--tag must match /^[a-z0-9][a-z0-9-]{0,39}$/')
  // One --accept cannot describe several tasks; a tasks file gives each task its own `accept`.
  if (options.accept !== undefined && tasks.length > 1)
    throw new Error('--accept applies to one task; give each task in the file its own "accept"')
  if (!options.add) return
  const missing = tasks.find((task) => task.role !== 'lead' && !(task.accept ?? options.accept)?.trim())
  if (!missing) return
  throw new Error(`--add needs an acceptance check for role ${missing.role}; pass --accept or set "accept" on the task`)
}

// The board refuses an off-catalog role at add; refuse it here, before paying for the Jev call. `unassigned`
// (no --role) still goes to Jev, whose confident owner answer replaces it.
function refuseOffCatalogAdd(tasks: Task[], options: RouteOptions) {
  if (!options.add) return
  const known = (role: unknown) => typeof role === 'string' && (role === 'unassigned' || Object.hasOwn(ROLES, role))
  const off = tasks.find((task) => !known(task.role))
  if (off) throw new Error(unknownRoleMessage(off.role))
}

function defaultBoardExec(script: string, argv: string[]) {
  execFileSync(process.execPath, [script, ...argv], { stdio: 'inherit', env: process.env })
}

// `list --all` prints the whole board, which outgrows execFileSync's 1 MiB default buffer (ENOBUFS).
const BOARD_LIST_MAX_BUFFER = 256 * 1024 * 1024

function readBoardTasks(boardScript: string): BoardTask[] {
  const stdout = execFileSync(process.execPath, [boardScript, 'list', '--all', '--json'], {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: BOARD_LIST_MAX_BUFFER,
  })
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('team-tasks list did not return a task list')
  return parsed
}

function boardTask(tasks: BoardTask[], taskId: string): Task {
  const id = Number(taskId)
  if (!Number.isInteger(id) || id < 1) throw new Error('--task needs a positive integer task id')
  const found = tasks.find((task) => task?.id === id)
  if (!found || typeof found.title !== 'string' || typeof found.role !== 'string')
    throw new Error(`task ${taskId} does not exist`)
  if (found.status === 'done' || found.status === 'cancelled')
    throw new Error(`task ${taskId} is ${found.status}; a done or cancelled task cannot take a verdict`)
  const after = Array.isArray(found.after) ? found.after.filter((item) => Number.isInteger(item)) : []
  return { title: found.title, role: found.role, after }
}

/** Dependency ids become { id, title, status } so Jev reads what the task waits on, not bare numbers. */
function withDependencies(task: Task, tasks: BoardTask[]): Task {
  if (!task.after?.length) return task
  const dependencies: Dependency[] = task.after.map((id) => {
    const found = tasks.find((candidate) => candidate?.id === id)
    const title = typeof found?.title === 'string' ? safeDependencyTitle(found.title) : 'not on the board'
    return { id, title, status: found?.status ?? 'unknown' }
  })
  return { ...task, dependencies }
}

function printedLine(task: Task, role: string, verdict: ReturnType<typeof verdictFrom>, answers: Answers) {
  return JSON.stringify({
    title: task.title,
    role,
    route: verdict.route,
    jevRoute: verdict.jevRoute,
    confidence: verdict.confidence,
    mechanical: answers.is_mechanical.noul,
    scope: answers.scope.score,
    subtlety: answers.subtlety.score,
    holds: verdict.holds,
    roleFits: verdict.roleFits,
    suggestedRole: verdict.suggestedRole,
    check: verdict.check,
    executor: verdict.executor,
    reasons: verdict.reasons,
  })
}

function writeVerdict(
  exec: BoardExec,
  board: string,
  task: Task,
  role: string,
  decision: Decision,
  verdict: ReturnType<typeof verdictFrom>,
  options: RouteOptions,
) {
  const payload = JSON.stringify(verdict)
  if (options.add) {
    const after = task.after?.length ? ['--after', task.after.join(',')] : []
    const accept = task.accept ? ['--accept', task.accept] : []
    const tag = options.tag ? ['--tag', options.tag] : []
    exec(board, ['add', role, task.title, ...after, '--route', decision.route, '--jev', payload, ...accept, ...tag])
    return
  }
  if (options.taskId) exec(board, ['jev', options.taskId, payload])
}

/** The tasks Jev judges: the CLI or file tasks, or the one board task, each with its brief and dependencies. */
function withRouteAccept(task: Task, accept: string | undefined): Task {
  if (!accept || task.accept !== undefined) return task
  return { ...task, accept }
}

function pickSubjects(tasks: Task[], boardTasks: BoardTask[], options: RouteOptions): Task[] {
  const brief = options.brief ? { brief: options.brief } : {}
  const picked = options.taskId ? [{ ...boardTask(boardTasks, options.taskId), ...brief }] : tasks
  return picked.map((task) => withDependencies(checkedText(withRouteAccept(task, options.accept)), boardTasks))
}

// The board is read only for --task or a task that waits on others.
const needsBoard = (tasks: Task[], options: RouteOptions) =>
  Boolean(options.taskId) || tasks.some((task) => Boolean(task.after?.length))

type ReusableRoute = { answers: Answers; answer: ChoiceAnswer | null }

function reusePath(task: Task, { reuse, availability }: RouteOptions) {
  if (!reuse || !availability?.available) return null
  if (!statSync(reuse.dir).isDirectory()) throw new Error('--reuse-dir needs a task-owned directory')
  const risk = cleanText(reuse.risk, 'reuse risk')
  const key = createHash('sha256').update(JSON.stringify({
    version: 1, model: 'jev-latest', thresholds: THRESHOLDS,
    role: task.role, risk, accept: task.accept,
    catalog: TIER_EXECUTORS,
    available: [...availability.available].sort(),
    unavailable: [...new Set(availability.unavailable)].sort(),
  })).digest('hex')
  return join(reuse.dir, `route-${key}.json`)
}

function loadReusableRoute(path: string | null, task: Task, availability?: Availability) {
  if (!path) return null
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as ReusableRoute
    const decision = decide(cached.answers, task)
    if (decision.holds.length || decision.roleFits !== true) return null
    if (isTierRoute(decision.route)) {
      const offered = availableFor(decision.route, availability)
      const choice = readChoice(cached.answer, offered)
      if (!offered.length || (offered.length > 1 && (!choice || choice.confidence < THRESHOLDS.minExecutorConfidence)))
        return null
    } else if (decision.route !== 'deterministic_script') return null
    return cached
  } catch {
    return null
  }
}

function saveReusableRoute(path: string, value: ReusableRoute) {
  assertApiKeyAbsent(value)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export async function routeTasks(tasks: Task[], client: Pick<TypeSafeClient, 'systemOne'>, options: RouteOptions = {}) {
  refuseMixedRouteFlags(options, tasks.length)
  refuseOffCatalogAdd(tasks, options)
  refuseAddWithoutAccept(tasks, options)
  const board = options.boardScript ?? join(import.meta.dirname, 'team-tasks.mjs')
  const exec = options.exec ?? defaultBoardExec
  const log = options.log ?? ((line: string) => console.log(line))
  const readTasks = options.readTasks ?? (() => readBoardTasks(board))
  const subjects = pickSubjects(tasks, needsBoard(tasks, options) ? readTasks() : [], options)
  if (options.reuse && (options.add || options.taskId || subjects.length !== 1 || needsBoard(tasks, options) || !options.availability?.available))
    throw new Error('route reuse requires a single standalone task and --available')
  const answered = await Promise.all(subjects.map(async (task) => {
    const path = reusePath(task, options)
    const cached = loadReusableRoute(path, task, options.availability)
    return { task, answers: cached?.answers ?? await askJev(client, task), path, cached }
  }))
  const results = []
  for (const { task, answers, path, cached } of answered) {
    const decision = decide(answers, task)
    const outcome = await chooseExecutor(client, task, decision, options.availability, cached ?? undefined)
    const verdict = verdictFrom(decision, answers, outcome)
    // On --add, Jev's confident owner replaces a role it judged wrong. An existing task keeps its role.
    const role = options.add && decision.adoptRole && decision.suggestedRole ? decision.suggestedRole : task.role
    const save = path && !cached && decision.roleFits === true && !decision.holds.length &&
      (decision.route === 'deterministic_script' || (outcome.executor && (outcome.offered.length === 1 || outcome.executor.source === 'jev')))
    if (save)
      saveReusableRoute(path, { answers, answer: outcome.answer })
    const line = printedLine(task, role, verdict, answers)
    log(cached || save ? JSON.stringify({ ...JSON.parse(line), reused: Boolean(cached), routingReceipt: path }) : line)
    writeVerdict(exec, board, task, role, decision, verdict, options)
    results.push({ task, role, answers, decision, verdict })
  }
  return results
}

function formatCalibration(report: CalibrationReport): string {
  const lines = [
    `rows ${report.rows}; legacy without answers ${report.legacyWithoutAnswers}; unreadable ${report.unreadable}; not a Jev route ${report.notAJevRoute}`,
    `final route matches ${report.finalRouteMatches}`,
    `verdict route matches ${report.verdictRouteMatches}`,
  ]
  if (report.note) lines.push(report.note)
  if (report.suggestion)
    lines.push(
      `suggested change: ${report.suggestion.name}=${report.suggestion.value} (final route matches ${report.suggestion.finalRouteMatches})`,
    )
  lines.push(...confusionLines(report), ...sweepLines(report))
  return lines.join('\n')
}

function confusionLines(report: CalibrationReport): string[] {
  const lines = ['confusion:']
  if (report.confusion.length === 0) lines.push('  (none)')
  for (const row of report.confusion) lines.push(`  ${row.final} -> ${row.replayed}: ${row.count}`)
  return lines
}

function sweepLines(report: CalibrationReport): string[] {
  const lines = ['sweep:']
  for (const row of report.sweep) lines.push(`  ${row.name}=${row.value}: final route matches ${row.finalRouteMatches}`)
  return lines
}

function runCalibrate(json: boolean) {
  const board = join(import.meta.dirname, 'team-tasks.mjs')
  const report = calibrate(readBoardTasks(board))
  console.log(json ? JSON.stringify(report, null, 2) : formatCalibration(report))
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function readTaskFlag(args: string[]) {
  const at = args.indexOf('--task')
  if (at === -1) return undefined
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--') || !/^[1-9]\d*$/.test(value))
    throw new Error(`${USAGE}\n--task needs a positive integer task id`)
  return value
}

function positionalArgs(args: string[]) {
  const valued = new Set([
    '--role',
    '--after',
    '--task',
    '--brief',
    '--accept',
    '--tag',
    '--available',
    '--unavailable',
    '--reuse-dir',
    '--reuse-risk',
  ])
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (valued.has(arg)) {
      index += 1
      continue
    }
    if (arg === '--add' || arg.startsWith('--')) continue
    positionals.push(arg)
  }
  return positionals
}

function refuseCliIdentityWithTask(args: string[], taskId: string | undefined) {
  if (!taskId) return
  if (args.includes('--role')) throw new Error('--task reads the role from the board; do not pass --role')
  if (args.includes('--after')) throw new Error('--task reads after from the board; do not pass --after')
  if (positionalArgs(args).length) throw new Error('--task reads the title from the board; do not pass a title')
}

if (isDirectRun()) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('--calibrate')) {
      runCalibrate(args.includes('--json'))
    } else {
      const taskId = readTaskFlag(args)
      refuseCliIdentityWithTask(args, taskId)
      if (args.includes('--add') && taskId) throw new Error('--add and --task cannot be used together')
      const tasks = taskId ? [{ title: '', role: '' }] : parseTasks(args)
      // Built on the first question, so a bad task id is reported before a missing key. Reads TYPESAFE_API_KEY.
      let built: TypeSafeClient | undefined
      const client: Pick<TypeSafeClient, 'systemOne'> = {
        systemOne: (request) => (built ??= new TypeSafeClient({ defaultModel: 'jev-latest' })).systemOne(request),
      }
      const accept = acceptFlag(args)
      const tag = tagFlag(args)
      const availability = availabilityFlags(args)
      const reuseDir = textFlag(args, '--reuse-dir')
      const reuseRisk = textFlag(args, '--reuse-risk')
      if (Boolean(reuseDir) !== Boolean(reuseRisk)) throw new Error('supply --reuse-dir and --reuse-risk together')
      await routeTasks(tasks, client, {
        add: args.includes('--add'),
        taskId,
        brief: taskId ? briefFlag(args) : undefined,
        accept,
        tag,
        availability,
        reuse: reuseDir && reuseRisk ? { dir: reuseDir, risk: reuseRisk } : undefined,
      })
    }
  } catch (error) {
    console.error(`jev-route failed: ${redactApiKey(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  }
}
