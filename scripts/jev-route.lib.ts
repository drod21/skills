// One Jev call judges a task's properties. Code maps them to an executor, holds, role fit, and the check.
// Jev answers what it can see in the task (scope, subtlety, risk). It never chooses the tier among overlapping
// executor descriptions: the route is a capability tier fixed here by code, and the tier's first available
// executor carries it (jev-executors.lib.ts). Uncertainty widens the tier instead of waking the lead: only a
// hold does that.
import { choice, noul, score, type TypeSafeClient } from '@typesafe-ai/sdk'

import { assertApiKeyAbsent } from './jev-guard.lib.ts'
import { CHECKS as catalogChecks, JEV_ROUTES, ROLES as catalogRoles } from './team-catalog.mjs'

type CatalogRoles = Record<string, string>
type CatalogChecks = {
  typecheck: string
  focused_test: string
  runtime: string
  none: string
}

// The board accepts every route here (team-tasks.lib.mjs JEV_ROUTES). gemini_patch stays valid board
// data from earlier verdicts, as do sol_patch, grok_patch and terra_patch; the table no longer emits them.
export const ROUTES = JEV_ROUTES
export type Route = (typeof ROUTES)[number]
export type Dependency = { id: number; title: string; status: string }
export type Task = {
  title: string
  role: string
  after?: number[]
  brief?: string
  accept?: string
  dependencies?: Dependency[]
}
export const HOLDS = ['risky', 'needs_decision'] as const
export type Hold = (typeof HOLDS)[number]

export const ROLES = catalogRoles as CatalogRoles
export const CHECKS = catalogChecks as CatalogChecks
export type Role = keyof CatalogRoles
export type Check = keyof CatalogChecks

type Level = 0 | 1 | 2
type ScoreAnswer = { score: number; confidence: number; probabilities: Record<string, number> }

export type Answers = {
  is_mechanical: { noul: number }
  scope: ScoreAnswer
  subtlety: ScoreAnswer
  risky: { noul: number }
  needs_decision: { noul: number }
  role_fits: { noul: number }
  owner: { choice: Role; confidence: number }
  check: { choice: Check; confidence: number }
}

// jevRoute: the executor Jev's answers imply at face value (each score rounded), before holds.
// route: the executor to dispatch. An uncertain score takes the widest level Jev gives real weight to;
// a hold makes it needs_lead.
// confidence: the lower of the scope and subtlety confidences, kept for calibration.
export type Decision = {
  route: Route
  jevRoute: Route
  confidence: number
  reasons: string[]
  holds: Hold[]
  roleFits: boolean
  suggestedRole: Role | null
  adoptRole: boolean
  check: Check | null
}

// Starting values; tune against real outcomes with the answers stored on each verdict.
// A noul near 0.5 is uncertainty, not a mild yes, so a hold requires a clear yes.
export const THRESHOLDS = {
  minScoreConfidence: 0.5,
  minWidenProbability: 0.25, // below the confidence floor, any level with this much probability counts
  minMechanicalForScript: 0.8,
  minHoldNoul: 0.7,
  minRoleFit: 0.6,
  minOwnerConfidence: 0.5,
  minCheckConfidence: 0.5,
} as const
export type Thresholds = typeof THRESHOLDS

// Rows are the scope level, columns the subtlety level. Chores go to Haiku or Luna, the code workhorse is Sonnet
// (dispatched in parallel waves, never one at a time; see dispatch.md), subtle slices go to Opus builders, and
// subtle cross-package changes stay with Opus. Reserve Fable for the absolute hardest coordination,
// planning, or execution tasks via an explicit lead escalation; scope and subtlety alone do not qualify.
export const EXECUTORS: Record<Level, readonly [Route, Route, Route]> = {
  0: ['haiku_fork', 'haiku_fork', 'opus_patch'],
  1: ['luna_patch', 'sonnet_patch', 'opus_patch'],
  2: ['sonnet_patch', 'sonnet_patch', 'opus_patch'],
}

const SCOPE_LEVELS = [
  'One file',
  'Two or three files in one package',
  'Several packages, or schema plus server plus client',
]
const SUBTLETY_LEVELS = [
  'Straightforward: an obvious edit, a copy change, or a pattern the repo already repeats',
  'Needs care: has to match neighboring code, a shared contract, or existing test fixtures',
  'Subtle: many call sites, a shared invariant, concurrency, native timing, or numeric thresholds',
]

export const QUESTIONS = {
  is_mechanical: noul(
    'An existing command (a check, generator, formatter, rename, or version bump) can carry out `task` with no design judgment',
  ),
  scope: score('How much of the codebase the change in `task` touches', SCOPE_LEVELS),
  subtlety: score(
    'Assuming the behavior in `task` is already decided, how easy is the change to get wrong?',
    SUBTLETY_LEVELS,
  ),
  risky: noul(
    {
      question:
        'Would carrying out `task` change persisted data, auth, billing, or production behavior in a way that is hard to undo?',
      inspect: '`task`',
    },
    {
      true: {
        what: 'Schema, migrations, user data, auth, secrets, billing, or a production write',
        examples: ['Drop the sessions table', 'Change who the auth callback accepts'],
      },
      false: {
        what: 'A local code, copy, or test change with no persisted-data or production side effect',
        not_for: 'Mentioning stored data in a read-only audit',
        examples: ['Fix a typo in onboarding copy', 'Add a unit test for set parsing'],
      },
    },
  ),
  needs_decision: noul(
    {
      question:
        'Does `task` leave a product or architecture choice unsettled, so an executor would have to invent the behavior?',
      inspect: '`task`',
    },
    {
      true: {
        what: 'The task names a goal but not the behavior to ship',
        examples: ['Make onboarding feel better', 'Decide how programs should sync'],
      },
      false: {
        what: 'The task states the change well enough to implement or check',
        not_for: 'Ordinary implementation judgment inside a stated change',
        examples: ['Rename the RPE label to Exertion'],
      },
    },
  ),
  role_fits: noul(
    {
      question: 'Is `task.role` the right owner for `task`, given `roles`?',
      compare: ['`task.role`', '`task`', '`roles`'],
    },
    {
      true: { what: 'The assigned role matches the kind of work' },
      false: {
        what: 'A different role owns this work, or the role is unassigned',
        examples: ['role unassigned', 'a schema change assigned to ux-worker'],
      },
    },
  ),
  // Speculative: read only when role_fits is below the floor.
  owner: choice('Which entry in `roles` should own `task`?', ROLES),
  check: choice('Which check should prove `task` once it is carried out?', CHECKS),
}

export function buildRequest(task: Task) {
  const dependsOn = task.dependencies ?? task.after ?? []
  const brief = task.brief?.trim()
  const accept = task.accept?.trim()
  return {
    state: {
      task: {
        title: task.title,
        role: task.role,
        ...(brief ? { brief } : {}),
        ...(accept ? { accept } : {}),
        dependsOn,
      },
      roles: ROLES,
    },
    questions: QUESTIONS,
  }
}

const clampLevel = (value: number): Level => (value <= 0 ? 0 : value >= 2 ? 2 : (value as Level))
const LEVELS: readonly Level[] = [0, 1, 2]

const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function scoreOk(value: unknown) {
  if (!isRecord(value) || !isRecord(value.probabilities)) return false
  const { score, confidence, probabilities } = value
  const finite = typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 2
  return finite && unit(confidence) && LEVELS.every((level) => unit(probabilities[String(level)]))
}

const choiceOk = (value: unknown, labels: object) =>
  isRecord(value) && typeof value.choice === 'string' && Object.hasOwn(labels, value.choice) && unit(value.confidence)

const NOULS = ['is_mechanical', 'risky', 'needs_decision', 'role_fits'] as const

/** The SDK checks the request, not the answers. A malformed answer must not slip past a hold. */
export function malformedAnswers(raw: unknown): string[] {
  const a = isRecord(raw) ? raw : {}
  const bad: string[] = NOULS.filter((key) => !isRecord(a[key]) || !unit((a[key] as { noul?: unknown }).noul))
  for (const key of ['scope', 'subtlety'] as const) if (!scoreOk(a[key])) bad.push(key)
  if (!choiceOk(a.owner, ROLES)) bad.push('owner')
  if (!choiceOk(a.check, CHECKS)) bad.push('check')
  return bad
}

// The face-value level, and the level to dispatch at. Below the confidence floor, dispatch at the widest
// level Jev still gives real probability, so a split between two levels takes the wider one.
function levels(name: string, answer: ScoreAnswer, reasons: string[], thresholds: Thresholds) {
  const face = clampLevel(Math.round(answer.score))
  if (answer.confidence >= thresholds.minScoreConfidence) return { face, used: face }
  const weighted = LEVELS.filter(
    (level) => (answer.probabilities[String(level)] ?? 0) >= thresholds.minWidenProbability,
  )
  const used = Math.max(face, ...weighted) as Level
  if (used !== face)
    reasons.push(`${name} confidence ${answer.confidence.toFixed(2)} below floor; took the wider level`)
  return { face, used }
}

function executor(a: Answers, scope: Level, subtlety: Level, thresholds: Thresholds): Route {
  if (a.is_mechanical.noul >= thresholds.minMechanicalForScript && scope <= 1 && subtlety === 0)
    return 'deterministic_script'
  return EXECUTORS[scope][subtlety]
}

// A confident "the lead should own this" is a decision for the lead, not a role to dispatch under.
const leadOwns = (a: Answers, roleFits: boolean, thresholds: Thresholds) =>
  !roleFits && a.owner.choice === 'lead' && a.owner.confidence >= thresholds.minOwnerConfidence

function collectHolds(a: Answers, roleFits: boolean, reasons: string[], thresholds: Thresholds): Hold[] {
  const holds: Hold[] = []
  if (a.risky.noul >= thresholds.minHoldNoul) {
    reasons.push(`risky ${a.risky.noul.toFixed(2)} holds for the lead`)
    holds.push('risky')
  }
  if (a.needs_decision.noul >= thresholds.minHoldNoul) {
    reasons.push(`needs a decision ${a.needs_decision.noul.toFixed(2)}`)
    holds.push('needs_decision')
  } else if (leadOwns(a, roleFits, thresholds)) {
    reasons.push(`Jev says the lead owns this (confidence ${a.owner.confidence.toFixed(2)})`)
    holds.push('needs_decision')
  }
  return holds
}

function suggestRole(a: Answers, task: Pick<Task, 'role'>, roleFits: boolean, reasons: string[]): Role | null {
  if (roleFits) return null
  reasons.push(`role fit ${a.role_fits.noul.toFixed(2)} below floor`)
  if (a.owner.choice === task.role) return null
  reasons.push(`Jev suggests ${a.owner.choice} (confidence ${a.owner.confidence.toFixed(2)})`)
  return a.owner.choice
}

/** Throws on a malformed answer, so no verdict is written from it. */
export function decide(a: Answers, task: Pick<Task, 'role'>, thresholds: Thresholds = THRESHOLDS): Decision {
  const bad = malformedAnswers(a)
  if (bad.length) throw new Error(`Jev returned malformed answers for ${bad.join(', ')}; no verdict written`)
  const reasons: string[] = []
  const scope = levels('scope', a.scope, reasons, thresholds)
  const subtlety = levels('subtlety', a.subtlety, reasons, thresholds)
  const jevRoute = executor(a, scope.face, subtlety.face, thresholds)
  const roleFits = a.role_fits.noul >= thresholds.minRoleFit
  const suggestedRole = suggestRole(a, task, roleFits, reasons)
  const holds = collectHolds(a, roleFits, reasons, thresholds)
  const route = holds.length ? 'needs_lead' : executor(a, scope.used, subtlety.used, thresholds)
  const adoptRole =
    suggestedRole !== null && suggestedRole !== 'lead' && a.owner.confidence >= thresholds.minOwnerConfidence
  const check = a.check.confidence >= thresholds.minCheckConfidence ? a.check.choice : null
  const confidence = Math.min(a.scope.confidence, a.subtlety.confidence)

  return { route, jevRoute, confidence, reasons, holds, roleFits, suggestedRole, adoptRole, check }
}

const SWEEP_KNOBS = [
  ['minScoreConfidence', [0.5, 0.6, 0.7, 0.8, 0.9]],
  ['minWidenProbability', [0.15, 0.25, 0.35]],
  ['minHoldNoul', [0.5, 0.6, 0.7, 0.8, 0.9]],
  ['minRoleFit', [0.5, 0.6, 0.7, 0.8, 0.9]],
  ['minMechanicalForScript', [0.5, 0.6, 0.7, 0.8, 0.9]],
] as const satisfies readonly (readonly [keyof Thresholds, readonly number[]])[]

export type CalibrationTask = {
  role?: string
  route?: string | null
  jev?: { route?: string; answers?: unknown } | null
}

export type CalibrationSuggestion = { name: string; value: number; finalRouteMatches: number }

export type CalibrationReport = {
  withAnswers: number
  legacyWithoutAnswers: number
  unreadable: number
  notAJevRoute: number
  rows: number
  finalRouteMatches: number
  verdictRouteMatches: number
  confusion: { final: string; replayed: string; count: number }[]
  sweep: { name: string; value: number; finalRouteMatches: number }[]
  suggestion: CalibrationSuggestion | null
  note: string | null
}

function answersKind(task: CalibrationTask): 'legacy' | 'unreadable' | 'row' {
  const jev = task.jev
  if (!jev || typeof jev !== 'object') return 'legacy'
  if (!Object.hasOwn(jev, 'answers') || jev.answers === undefined) return 'legacy'
  return malformedAnswers(jev.answers).length ? 'unreadable' : 'row'
}

function isJevRoute(route: unknown): route is Route {
  return typeof route === 'string' && (ROUTES as readonly string[]).includes(route)
}

function replayedRoute(task: CalibrationTask, thresholds: Thresholds): Route | null {
  try {
    const role = typeof task.role === 'string' ? task.role : ''
    return decide(task.jev?.answers as Answers, { role }, thresholds).route
  } catch {
    return null
  }
}

function confusionTable(counts: Map<string, number>): CalibrationReport['confusion'] {
  return [...counts.entries()]
    .map(([key, count]) => {
      const [final, replayed] = key.split('\0')
      return { final: final ?? '', replayed: replayed ?? '', count }
    })
    .sort((left, right) => left.final.localeCompare(right.final) || left.replayed.localeCompare(right.replayed))
}

function countAgreement(rows: CalibrationTask[], thresholds: Thresholds) {
  let finalRouteMatches = 0
  let verdictRouteMatches = 0
  let notAJevRoute = 0
  const counts = new Map<string, number>()
  for (const task of rows) {
    if (!isJevRoute(task.route)) {
      notAJevRoute += 1
      continue
    }
    const replayed = replayedRoute(task, thresholds)
    if (!replayed) continue
    if (replayed === task.route) finalRouteMatches += 1
    if (typeof task.jev?.route === 'string' && replayed === task.jev.route) verdictRouteMatches += 1
    const key = `${task.route}\0${replayed}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return { finalRouteMatches, verdictRouteMatches, notAJevRoute, confusion: confusionTable(counts) }
}

function sweepThresholds(rows: CalibrationTask[], base: Thresholds): CalibrationReport['sweep'] {
  const sweep: CalibrationReport['sweep'] = []
  for (const [name, values] of SWEEP_KNOBS) {
    for (const value of values) {
      const scored = countAgreement(rows, { ...base, [name]: value })
      sweep.push({ name, value, finalRouteMatches: scored.finalRouteMatches })
    }
  }
  return sweep
}

function suggestedKnob(rowCount: number, baseMatches: number, sweep: CalibrationReport['sweep']) {
  if (rowCount < 30) return { suggestion: null, note: 'fewer than 30 rows; no threshold change suggested' }
  let suggestion: CalibrationSuggestion | null = null
  for (const point of sweep) {
    if (point.finalRouteMatches <= baseMatches) continue
    if (!suggestion || point.finalRouteMatches > suggestion.finalRouteMatches)
      suggestion = { name: point.name, value: point.value, finalRouteMatches: point.finalRouteMatches }
  }
  return { suggestion, note: null }
}

/** Replays stored answers. Does not edit THRESHOLDS and does not throw on a bad row. */
export function calibrate(tasks: readonly CalibrationTask[], base: Thresholds = THRESHOLDS): CalibrationReport {
  const rows: CalibrationTask[] = []
  let legacyWithoutAnswers = 0
  let unreadable = 0
  for (const task of tasks) {
    const kind = answersKind(task)
    if (kind === 'legacy') legacyWithoutAnswers += 1
    else if (kind === 'unreadable') unreadable += 1
    else rows.push(task)
  }
  const scored = countAgreement(rows, base)
  const sweep = sweepThresholds(rows, base)
  const { suggestion, note } = suggestedKnob(rows.length, scored.finalRouteMatches, sweep)
  return {
    withAnswers: rows.length,
    legacyWithoutAnswers,
    unreadable,
    notAJevRoute: scored.notAJevRoute,
    rows: rows.length,
    finalRouteMatches: scored.finalRouteMatches,
    verdictRouteMatches: scored.verdictRouteMatches,
    confusion: scored.confusion,
    sweep,
    suggestion,
    note,
  }
}

// The SDK retries rate limits and overloads itself.
export async function askJev(client: Pick<TypeSafeClient, 'systemOne'>, task: Task): Promise<Answers> {
  const request = buildRequest(task)
  assertApiKeyAbsent(request)
  const { answers } = await client.systemOne(request)
  return answers
}
