// Which model carries a route. A route (jev-route.lib.ts EXECUTORS) stays a capability tier chosen from
// scope and subtlety. The registry (scripts/jev-executors.catalog.mjs) lists the executors that can carry
// each tier, in order. This file filters them by what the lead's harness offers; the first available entry
// carries the task. There is no Jev call here: the tier default is the owner's model for that job, and the
// later entries are fallbacks for an outage, never a second opinion on the model.
import * as z from 'zod'

import { TIER_EXECUTORS as catalogTiers } from './jev-executors.catalog.mjs'

/**
 * Routes with a registry tier. decide() emits all but LEGACY_TIER_ROUTES, which keep their tiers so stored
 * verdicts and lead overrides still match. sol_patch and gemini_patch stay valid board data with no tier.
 */
export const TIER_ROUTES = [
  'haiku_fork',
  'luna_patch',
  'grok_patch',
  'sonnet_patch',
  'terra_patch',
  'opus_patch',
  'fable_patch',
] as const
export const LEGACY_TIER_ROUTES = ['grok_patch', 'terra_patch'] as const
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
const catalogRow = z.strictObject({
  id: z.string(),
  providerInstanceId: z.string(),
  model: z.string(),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  family: z.string(),
  cost: z.union([z.tuple([z.number(), z.number()]), z.null()]),
})
const tierCatalog = z.strictObject({
  haiku_fork: z.array(catalogRow),
  luna_patch: z.array(catalogRow),
  grok_patch: z.array(catalogRow),
  sonnet_patch: z.array(catalogRow),
  terra_patch: z.array(catalogRow),
  opus_patch: z.array(catalogRow),
  fable_patch: z.array(catalogRow),
})
const checkedTiersResult = tierCatalog.safeParse(catalogTiers)
if (!checkedTiersResult.success) throw new Error(`executor catalog: ${z.prettifyError(checkedTiersResult.error)}`)
const checkedTiers = checkedTiersResult.data

const codeSpecialized = (model: string) => /(^|[-/])code($|[-.])/.test(model)
const executorsById = new Map<string, Executor>()

function asExecutor(row: z.infer<typeof catalogRow>): Executor {
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
  opus_patch: checkedTiers.opus_patch.map(asExecutor),
  fable_patch: checkedTiers.fable_patch.map(asExecutor),
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

const trimmed = z.string().transform((text) => text.trim())
const pair = trimmed
  .refine((text) => {
    const at = text.indexOf(':')
    return at > 0 && at < text.length - 1
  }, 'must be a providerInstanceId:model pair')
  .transform((text) => {
    const at = text.indexOf(':')
    return `${text.slice(0, at).trim()}:${text.slice(at + 1).trim()}`
  })
const modelToken = z
  .union([trimmed, z.object({ id: z.string() }).transform((model) => model.id.trim())])
  .refine((id) => id.length > 0, 'must be a model id')
// Extra harness fields are dropped. A string canRun is kept so the fail-closed rule can exclude it.
// A runnable row must name what runs, so a row that passes the schema always yields at least one id.
const availableRow = z
  .object({
    providerInstanceId: trimmed.refine((id) => id.length > 0, 'must be a providerInstanceId'),
    model: trimmed.exactOptional(),
    models: z.array(modelToken).exactOptional(),
    canRun: z.union([z.boolean(), z.string()]).exactOptional(),
  })
  .refine(
    (row) => row.canRun !== true || Boolean(row.model) || (row.models?.length ?? 0) > 0,
    'must be a runnable row with a model or models',
  )
const availableEntry = z.union([pair, availableRow])
const availableList = z.array(availableEntry)
const availableCatalog = z.object({ capabilities: availableList })
const jsonText = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid JSON' })
    return z.NEVER
  }
})

type AvailableEntry = z.infer<typeof availableEntry>

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
  const list = availableList.safeParse(raw)
  if (list.success) return new Set(list.data.flatMap(idsOf))
  const catalog = availableCatalog.safeParse(raw)
  if (!catalog.success) throw new Error('--available needs a JSON list of valid entries')
  return new Set(catalog.data.capabilities.flatMap(idsOf))
}

/** The same set, from the raw text of an --available file. Invalid JSON is refused here. */
export function parseAvailableText(text: string): Set<string> {
  const json = jsonText.safeParse(text)
  if (!json.success) throw new Error('--available is not readable JSON')
  return parseAvailable(json.data)
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

/** No executor (the lead picks) or the first available one. A stored `jev` source is older board data. */
export type ExecutorPick =
  | { executor: null; source: null; reasons: string[] }
  | { executor: Executor; source: 'jev' | 'default'; reasons: string[] }

/** Pure: the first available executor of the tier, with a reason when the tier default is not available. */
export function pickExecutor(route: TierRoute, offered: readonly Executor[]): ExecutorPick {
  const [first] = offered
  if (!first)
    return { executor: null, source: null, reasons: [`no executor is available for ${route}; the lead picks`] }
  const tierDefault = TIER_EXECUTORS[route][0]
  const reasons =
    tierDefault && first.id !== tierDefault.id
      ? [`tier default ${tierDefault.id} is unavailable; took ${first.id}`]
      : []
  return { executor: first, source: 'default', reasons }
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
