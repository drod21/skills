// Which model carries a route. A route (jev-route.lib.ts EXECUTORS) stays a capability tier chosen from
// scope and subtlety. The registry (scripts/jev-executors.catalog.mjs) lists the executors that can carry
// each tier. This file filters them by what the lead's harness offers and asks Jev one choice question
// over what is left.
//
// Jev picks only among executors of the tier code already chose, and only when it is confident
// (THRESHOLDS.minExecutorConfidence). A pick that is unconfident, malformed, or names an executor that was
// not offered falls back to the first available executor, which is the tier default whenever the default is
// available. The fallback is what protects the old rule that Jev never decides on a weak read: a poor or
// failed answer costs a default dispatch, never a wrong tier. The facts below are catalog facts (family,
// list price, a name that says "code"); none is a quality claim, so Jev has nothing to rank on but the task.
import { choice, type TypeSafeClient } from '@typesafe-ai/sdk'
import { type } from 'arktype'

import { TIER_EXECUTORS as catalogTiers } from './jev-executors.catalog.mjs'
import { assertApiKeyAbsent } from './jev-guard.lib.ts'

/** Routes decide() emits that dispatch to a model. sol_patch and gemini_patch stay valid board data only. */
export const TIER_ROUTES = ['haiku_fork', 'luna_patch', 'grok_patch', 'sonnet_patch', 'terra_patch'] as const
export type TierRoute = (typeof TIER_ROUTES)[number]

export type ExecutorOptions = Record<string, string | number | boolean>

export type Executor = {
  /** `<providerInstanceId>:<model>`: stable, and the string a lead writes in --available and --unavailable. */
  id: string
  providerInstanceId: string
  /** The model id exactly as delegate_task takes it. */
  model: string
  /** Defaults for delegate_task options. Empty means the provider's own default. */
  options: ExecutorOptions
  facts: {
    family: string
    /** USD per million tokens, input then output; null when the catalog snapshot has no price. */
    costPerMtok: { input: number; output: number } | null
    /** True only when the model's name says it is code-specialized. */
    codeSpecialized: boolean
  }
}

// The catalog module is plain JS. This schema is the boundary: past it, every row is a typed registry entry.
const catalogRow = type({
  '+': 'reject',
  id: 'string',
  providerInstanceId: 'string',
  model: 'string',
  options: { '[string]': 'string | number | boolean' },
  family: 'string',
  cost: type(['number', 'number']).or('null'),
})
const tierCatalog = type({
  '+': 'reject',
  haiku_fork: catalogRow.array(),
  luna_patch: catalogRow.array(),
  grok_patch: catalogRow.array(),
  sonnet_patch: catalogRow.array(),
  terra_patch: catalogRow.array(),
})
const checkedTiers = tierCatalog(catalogTiers)
if (checkedTiers instanceof type.errors) throw new Error(`executor catalog: ${checkedTiers.summary}`)

const codeSpecialized = (model: string) => /(^|[-/])code($|[-.])/.test(model)
const executorsById = new Map<string, Executor>()

function asExecutor(row: typeof catalogRow.infer): Executor {
  const existing = executorsById.get(row.id)
  if (existing) return existing
  const cost = row.cost
  const executor: Executor = {
    id: row.id,
    providerInstanceId: row.providerInstanceId,
    model: row.model,
    options: { ...row.options },
    facts: {
      family: row.family,
      costPerMtok: cost ? { input: cost[0], output: cost[1] } : null,
      codeSpecialized: codeSpecialized(row.model),
    },
  }
  executorsById.set(row.id, executor)
  return executor
}

/** Ordered executors per tier. The first entry is the tier default and must match the coordinator skill's map. */
export const TIER_EXECUTORS: Record<TierRoute, readonly Executor[]> = {
  haiku_fork: checkedTiers.haiku_fork.map(asExecutor),
  luna_patch: checkedTiers.luna_patch.map(asExecutor),
  grok_patch: checkedTiers.grok_patch.map(asExecutor),
  sonnet_patch: checkedTiers.sonnet_patch.map(asExecutor),
  terra_patch: checkedTiers.terra_patch.map(asExecutor),
}

/** What each tier is for, taken from the scope x subtlety table in jev-route.lib.ts. */
export const TIER_PURPOSE: Record<TierRoute, string> = {
  haiku_fork: 'One file, straightforward or needing care',
  luna_patch: 'Two or three files in one package, straightforward',
  grok_patch: 'Two or three files in one package that must match neighboring code or a shared contract',
  sonnet_patch: 'Several packages, straightforward or needing care',
  terra_patch: 'Subtle change at any scope: many call sites, a shared invariant, concurrency, native timing, numbers',
}

export const isTierRoute = (route: string): route is TierRoute => (TIER_ROUTES as readonly string[]).includes(route)

/** Every distinct executor in the registry, by id. */
export function allExecutors(): Executor[] {
  return [...executorsById.values()]
}

// ---- availability --------------------------------------------------------------------------------------

export type Availability = {
  /** Allowed `providerInstanceId:model` ids. Absent means every registry entry counts as available. */
  available?: ReadonlySet<string>
  /** `providerInstanceId` (the whole provider) or `providerInstanceId:model`. */
  unavailable?: readonly string[]
}

const trimmed = type('string').pipe((text) => text.trim())
const pair = trimmed
  .narrow((text, ctx) => {
    const at = text.indexOf(':')
    return (at > 0 && at < text.length - 1) || ctx.mustBe('a providerInstanceId:model pair')
  })
  .pipe((text) => {
    const at = text.indexOf(':')
    return `${text.slice(0, at).trim()}:${text.slice(at + 1).trim()}`
  })
const modelToken = trimmed
  .or(type({ '+': 'delete', id: 'string' }).pipe((model) => model.id.trim()))
  .narrow((id, ctx) => id.length > 0 || ctx.mustBe('a model id'))
// Extra harness fields are dropped. A string canRun is kept so the fail-closed rule can exclude it.
// A runnable row must name what runs, so a row that passes the schema always yields at least one id.
const availableRow = type({
  '+': 'delete',
  providerInstanceId: trimmed.narrow((id, ctx) => id.length > 0 || ctx.mustBe('a providerInstanceId')),
  'model?': trimmed,
  'models?': modelToken.array(),
  'canRun?': 'boolean | string',
}).narrow(
  (row, ctx) =>
    row.canRun !== true ||
    Boolean(row.model) ||
    (row.models?.length ?? 0) > 0 ||
    ctx.mustBe('a runnable row with a model or models'),
)
const availableEntry = pair.or(availableRow)
const availableList = availableEntry.array()
const availableCatalog = type({ '+': 'delete', capabilities: availableList })
const jsonText = type('string.json.parse')

type AvailableEntry = typeof availableEntry.infer

function idsOf(entry: AvailableEntry): string[] {
  if (typeof entry === 'string') return [entry]
  // Only an explicit boolean true can run. A missing flag, a string, or false offers nothing.
  if (entry.canRun !== true) return []
  if (entry.model) return [`${entry.providerInstanceId}:${entry.model}`]
  return (entry.models ?? []).map((id) => `${entry.providerInstanceId}:${id}`)
}

/**
 * Offered `providerInstanceId:model` ids from a parsed --available value: a list of strings or objects, or
 * the harness catalog (`{ capabilities }`). String entries are an allow-list. An object counts only when
 * `canRun` is boolean true.
 */
export function parseAvailable(raw: unknown): Set<string> {
  const list = availableList(raw)
  if (!(list instanceof type.errors)) return new Set(list.flatMap(idsOf))
  const catalog = availableCatalog(raw)
  if (catalog instanceof type.errors) throw new Error('--available needs a JSON list of valid entries')
  return new Set(catalog.capabilities.flatMap(idsOf))
}

/** The same set, from the raw text of an --available file. Invalid JSON is refused here. */
export function parseAvailableText(text: string): Set<string> {
  const json = jsonText(text)
  if (json instanceof type.errors) throw new Error('--available is not readable JSON')
  return parseAvailable(json)
}

function unavailableBy(entry: Executor, unavailable: readonly string[]) {
  return unavailable.some((item) => item === entry.providerInstanceId || item === entry.id)
}

/** The tier's executors the lead's harness can run, in registry order. */
export function availableFor(route: TierRoute, availability: Availability = {}): Executor[] {
  const { available, unavailable = [] } = availability
  return TIER_EXECUTORS[route].filter(
    (entry) => (!available || available.has(entry.id)) && !unavailableBy(entry, unavailable),
  )
}

// ---- the pick ------------------------------------------------------------------------------------------

/** No executor (the lead picks) or one executor with the source that chose it. */
export type ExecutorPick =
  | { executor: null; source: null; reasons: string[] }
  | { executor: Executor; source: 'jev' | 'default'; reasons: string[] }

const unitInterval = type('number').narrow(
  (value, ctx) => (Number.isFinite(value) && value >= 0 && value <= 1) || ctx.mustBe('a number from 0 to 1'),
)
// Extra fields are dropped; malformed probabilities make the answer unusable.
const choiceAnswer = type({
  '+': 'delete',
  choice: 'string',
  confidence: unitInterval,
  'probabilities?': { '[string]': unitInterval },
})

/** What Jev answered, as read from its response. Anything else counts as no answer. */
export type ChoiceAnswer = typeof choiceAnswer.infer

export function readChoice(raw: unknown, offered: readonly Executor[]): ChoiceAnswer | null {
  const ids = new Set(offered.map((entry) => entry.id))
  const schema = choiceAnswer.narrow((value) => ids.has(value.choice))
  const parsed = schema(raw)
  if (parsed instanceof type.errors) return null
  return {
    ...parsed,
    ...(parsed.probabilities && {
      probabilities: Object.fromEntries(Object.entries(parsed.probabilities).filter(([key]) => ids.has(key))),
    }),
  }
}

/**
 * Pure: the executor to dispatch, given the tier's available executors and Jev's answer (null when Jev was
 * not asked or gave nothing usable). Jev's pick stands only when it is an offered id and its confidence
 * reaches `minConfidence`; otherwise the first available executor stands.
 */
export function pickExecutor(
  route: TierRoute,
  offered: readonly Executor[],
  answer: ChoiceAnswer | null,
  minConfidence: number,
): ExecutorPick {
  const [first] = offered
  if (!first)
    return { executor: null, source: null, reasons: [`no executor is available for ${route}; the lead picks`] }
  const reasons: string[] = []
  const tierDefault = TIER_EXECUTORS[route][0]
  if (tierDefault && first.id !== tierDefault.id)
    reasons.push(`tier default ${tierDefault.id} is unavailable; default is ${first.id}`)
  if (offered.length === 1) return { executor: first, source: 'default', reasons }
  if (!answer) {
    reasons.push('no executor pick from Jev; took the default')
    return { executor: first, source: 'default', reasons }
  }
  const picked = offered.find((entry) => entry.id === answer.choice)
  if (!picked) {
    reasons.push('Jev picked an executor that was not offered; took the default')
    return { executor: first, source: 'default', reasons }
  }
  if (answer.confidence < minConfidence) {
    reasons.push(
      `executor pick ${picked.id} confidence ${answer.confidence.toFixed(2)} below floor ${minConfidence}; took the default`,
    )
    return { executor: first, source: 'default', reasons }
  }
  reasons.push(`Jev picked ${picked.id} (confidence ${answer.confidence.toFixed(2)})`)
  return { executor: picked, source: 'jev', reasons }
}

// ---- the Jev call --------------------------------------------------------------------------------------

function describe(entry: Executor): string {
  const { family, costPerMtok, codeSpecialized: specialized } = entry.facts
  const price = costPerMtok
    ? `$${costPerMtok.input} in / $${costPerMtok.output} out per million tokens`
    : 'price unknown'
  const options = Object.entries(entry.options)
  const defaults = options.length ? `; default ${options.map(([key, value]) => `${key}=${value}`).join(', ')}` : ''
  return `${family} model ${entry.model} on ${entry.providerInstanceId}; ${price}${specialized ? '; code-specialized' : ''}${defaults}`
}

export type PickTask = { title: string; role: string; brief?: string; accept?: string }

export function buildPickRequest(task: PickTask, route: TierRoute, offered: readonly Executor[]) {
  const labels = Object.fromEntries(offered.map((entry) => [entry.id, describe(entry)]))
  const brief = task.brief?.trim()
  const accept = task.accept?.trim()
  return {
    state: {
      task: { title: task.title, role: task.role, ...(brief ? { brief } : {}), ...(accept ? { accept } : {}) },
      tier: { route, purpose: TIER_PURPOSE[route] },
    },
    questions: {
      executor: choice(
        `Which executor in \`executors\` should carry \`task\`, which is already assigned to the ${route} tier (\`tier.purpose\`)?`,
        labels,
      ),
    },
  }
}

export type PickResult = { pick: ExecutorPick; answer: ChoiceAnswer | null }

/**
 * One Jev choice over the available executors. No call for zero or one executor. A failed or unreadable call
 * falls back to the default; the reason says so, so an outage is visible in the verdict.
 */
export async function askExecutor(
  client: Pick<TypeSafeClient, 'systemOne'>,
  task: PickTask,
  route: TierRoute,
  offered: readonly Executor[],
  minConfidence: number,
): Promise<PickResult> {
  if (offered.length < 2) return { pick: pickExecutor(route, offered, null, minConfidence), answer: null }
  let answer: ChoiceAnswer | null = null
  let failure = false
  try {
    const request = buildPickRequest(task, route, offered)
    assertApiKeyAbsent(request)
    const response = await client.systemOne(request)
    const envelope = type({ '+': 'delete', answers: { '+': 'delete', executor: 'unknown' } })(response)
    if (!(envelope instanceof type.errors)) answer = readChoice(envelope.answers.executor, offered)
  } catch {
    failure = true
  }
  const pick = pickExecutor(route, offered, answer, minConfidence)
  if (failure) pick.reasons.push('executor pick failed')
  return { pick, answer }
}

/** The verdict's executor field. */
export type VerdictExecutor = {
  id: string
  providerInstanceId: string
  model: string
  options: ExecutorOptions
  source: 'jev' | 'default'
}

export function verdictExecutor(pick: ExecutorPick): VerdictExecutor | null {
  if (pick.source === null) return null
  const { id, providerInstanceId, model, options } = pick.executor
  return { id, providerInstanceId, model, options: { ...options }, source: pick.source }
}
