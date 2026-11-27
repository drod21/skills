// The executor registry, shared by the picker (scripts/jev-executors.lib.ts) and the board
// (scripts/team-tasks.lib.mjs). One row per executor. A tier lists those rows in order; the first is the
// tier default. Prices are the OpenCode catalog snapshot of 2026-11-01; Fable 5.2 is the 2026-11-25 snapshot.

/** Sources a stored verdict may name. */
export const EXECUTOR_SOURCES = ['jev', 'default']

function row(providerInstanceId, model, family, cost, options = {}) {
  return Object.freeze({
    id: `${providerInstanceId}:${model}`,
    providerInstanceId,
    model,
    options: Object.freeze({ ...options }),
    family,
    cost: cost ? Object.freeze([cost[0], cost[1]]) : null,
  })
}

const OC = 'opencode'

// The `claudeAgent` instance is disabled in the harness; `claudeAgent_2` runs Claude children.
const CLAUDE_HAIKU = row('claudeAgent_2', 'claude-haiku-5-5', 'Claude', [0.1, 0.5], { effort: 'medium' })
const CLAUDE_SONNET = row('claudeAgent_2', 'claude-sonnet-5-5', 'Claude', [2, 10], { effort: 'high' })
const CLAUDE_OPUS = row('claudeAgent_2', 'claude-opus-5-5', 'Claude', [4, 20], { effort: 'high' })
const CLAUDE_FABLE = row('claudeAgent_2', 'claude-fable-5-2', 'Claude', [8, 40], { effort: 'high' })
const CODEX_LUNA = row('codex', 'gpt-6-luna', 'GPT', [0.1, 0.5], { reasoningEffort: 'medium' })
// Terra at its default effort (low) quits after setup, so the tier default asks for high.
const CODEX_TERRA = row('codex', 'gpt-6.1-terra', 'GPT', [1, 5], { reasoningEffort: 'high' })
const CURSOR_GROK = row('cursor', 'grok-4.7', 'Grok', [2, 6], { reasoning_effort: 'high' })
const GROK_DIRECT = row('grok', 'grok-4.7', 'Grok', [2, 6], { reasoningEffort: 'high' })
// Cursor rows reuse the OpenCode snapshot price of the same model.
const CURSOR_DEEPSEEK_FLASH = row('cursor', 'deepseek-v41-flash-1017', 'DeepSeek', [0.15, 0.6], {
  reasoning_effort: 'high',
})
const CURSOR_GLM_FLASH = row('cursor', 'glm-5p3-flash', 'GLM', [0.15, 0.5], { reasoning: 'high' })
const CURSOR_KIMI_CODE = row('cursor', 'kimi-k2.7-code', 'Kimi', [0.95, 4])
const CURSOR_GLM = row('cursor', 'glm-5p3', 'GLM', [1.4, 4.4], { reasoning: 'high' })
const CURSOR_KIMI_K3 = row('cursor', 'kimi-k3', 'Kimi', [3, 15], { reasoning: 'high' })
const CURSOR_GEMINI = row('cursor', 'gemini-4-argon', 'Gemini', [2, 10], { reasoning_effort: 'high' })
const CURSOR_OPUS = row('cursor', 'claude-opus-5-5', 'Claude', [4, 20], { effort: 'high' })
const OC_GPT_LUNA = row(OC, 'console-openai/gpt-6-luna', 'GPT', [0.1, 0.5])
const OC_QWEN_FLASH = row(OC, 'opencode/qwen3.8-flash', 'Qwen', [0.15, 0.47])
const OC_DEEPSEEK_FLASH = row(OC, 'opencode-go/deepseek-v4.1-flash', 'DeepSeek', [0.15, 0.6])
const OC_GLM_FLASH = row(OC, 'opencode-go/glm-5.3-flash', 'GLM', [0.15, 0.5])
const OC_MINIMAX_FLASH = row(OC, 'opencode-go/minimax-m3.1-flash', 'MiniMax', [0.15, 0.6])
const OC_KIMI_CODE = row(OC, 'opencode/kimi-k2.7-code', 'Kimi', [0.95, 4])
const OC_GLM = row(OC, 'opencode/glm-5.3', 'GLM', [1.4, 4.4])
const OC_MINIMAX = row(OC, 'opencode/minimax-m3', 'MiniMax', [0.3, 1.2])
const OC_QWEN_PLUS = row(OC, 'opencode-go/qwen3.7-plus', 'Qwen', [0.4, 1.6])
const OC_MISTRAL = row(OC, 'opencode/mistral-large-4', 'Mistral', [0.68, 2.09])
const OC_XAI_GROK = row(OC, 'console-xai/grok-4.7', 'Grok', [2, 6])
const OC_KIMI_K3 = row(OC, 'opencode/kimi-k3', 'Kimi', [3, 15])
const OC_DEEPSEEK_PRO = row(OC, 'opencode-go/deepseek-v4-pro', 'DeepSeek', [0.66, 1.98])
const OC_QWEN_MAX = row(OC, 'opencode-go/qwen3.8-max', 'Qwen', [2, 6])
const OC_GEMINI = row(OC, 'opencode/gemini-4-argon', 'Gemini', [2, 10])
const OC_KIMI_PRO = row(OC, 'opencode-go/kimi-k3.1-pro', 'Kimi', [2, 10])
const OC_GPT_SOL = row(OC, 'console-openai/gpt-6.1-sol', 'GPT', [2, 10])

/** Ordered rows per tier. The first entry is the tier default. */
export const TIER_EXECUTORS = Object.freeze({
  haiku_fork: Object.freeze([
    CLAUDE_HAIKU,
    CURSOR_DEEPSEEK_FLASH,
    CURSOR_GLM_FLASH,
    OC_GPT_LUNA,
    OC_QWEN_FLASH,
    OC_DEEPSEEK_FLASH,
    OC_GLM_FLASH,
    OC_MINIMAX_FLASH,
  ]),
  luna_patch: Object.freeze([
    CODEX_LUNA,
    CURSOR_KIMI_CODE,
    CURSOR_GLM,
    OC_KIMI_CODE,
    OC_GLM,
    OC_MINIMAX,
    OC_QWEN_PLUS,
    OC_MISTRAL,
  ]),
  grok_patch: Object.freeze([
    CURSOR_GROK,
    CURSOR_KIMI_K3,
    CURSOR_GLM,
    GROK_DIRECT,
    OC_XAI_GROK,
    OC_KIMI_K3,
    OC_DEEPSEEK_PRO,
    OC_GLM,
  ]),
  sonnet_patch: Object.freeze([
    CLAUDE_SONNET,
    CURSOR_KIMI_K3,
    CURSOR_GEMINI,
    OC_KIMI_K3,
    OC_QWEN_MAX,
    OC_GEMINI,
    OC_MISTRAL,
    OC_KIMI_PRO,
  ]),
  // terra_patch is no longer emitted; it stays so stored verdicts and lead overrides still match.
  terra_patch: Object.freeze([CODEX_TERRA, CLAUDE_OPUS, CURSOR_OPUS, CURSOR_GEMINI, OC_GPT_SOL, OC_GEMINI, OC_KIMI_PRO]),
  // Opus builders: one subtle slice per builder, several builders in parallel worktrees.
  opus_patch: Object.freeze([CLAUDE_OPUS, CURSOR_OPUS, CODEX_TERRA, CURSOR_GEMINI, OC_GEMINI]),
  // Fable: explicit escalation for the absolute hardest coordination, planning, or execution tasks, in any role.
  fable_patch: Object.freeze([CLAUDE_FABLE, CLAUDE_OPUS, CURSOR_OPUS]),
})

const BY_ID = new Map()
for (const list of Object.values(TIER_EXECUTORS)) {
  for (const entry of list) {
    if (entry.id !== `${entry.providerInstanceId}:${entry.model}`)
      throw new Error('executor catalog id does not match its provider and model')
    const prior = BY_ID.get(entry.id)
    if (prior && prior !== entry) throw new Error(`executor catalog has two rows for ${entry.id}`)
    BY_ID.set(entry.id, entry)
  }
}

function sameOptions(expected, actual) {
  const expectedKeys = Object.keys(expected)
  const actualKeys = Reflect.ownKeys(actual)
  if (actualKeys.length !== expectedKeys.length) return false
  return expectedKeys.every((key) => Object.hasOwn(actual, key) && Object.is(actual[key], expected[key]))
}

function registryRow(id, providerInstanceId, model, options) {
  const entry = BY_ID.get(id)
  if (!entry || entry.providerInstanceId !== providerInstanceId) return null
  if (entry.model !== model || !sameOptions(entry.options, options)) return null
  return entry
}

/**
 * The executor object the board may store, or a refusal. `id` must be a registry id, and
 * providerInstanceId, model, and options must equal that row. Unknown fields are refused.
 * The message never echoes the payload, so a huge option cannot bloat the error.
 * @param {{ id: string, providerInstanceId: string, model: string, options: Record<string, string | number | boolean>, source: 'jev' | 'default' }} executor Parsed at the board boundary.
 * @param {string} route
 * @returns {{ ok: true, executor: { id: string, providerInstanceId: string, model: string, options: Record<string, string | number | boolean>, source: 'jev' | 'default' } } | { ok: false, message: string }}
 */
export function matchStoredExecutor(executor, route) {
  const { id, providerInstanceId, model, options, source } = executor
  const entry = registryRow(id, providerInstanceId, model, options)
  if (!entry) return { ok: false, message: 'executor does not match the registry' }
  if (!TIER_EXECUTORS[route]?.includes(entry)) return { ok: false, message: 'executor is not in the route tier' }
  return {
    ok: true,
    executor: {
      id: entry.id,
      providerInstanceId: entry.providerInstanceId,
      model: entry.model,
      options: { ...entry.options },
      source,
    },
  }
}
