import './jev-node-only.mjs'
import { resolveBoardFile } from './team-board-path.mjs'
// Score fix or approach options with one Jev call before the lead recommends or dispatches.
// Usage: node scripts/jev-decide.ts <input.json> [--dry-run] [--out <result.json>] [--model jev-latest] [--force] [--task <id> --by <owner>]
//        node scripts/jev-decide.ts --rescore <result.json> [--out <rescored.json>] [--force]
// Input:  { decision, context, rubric?, options: [{ id, title, description, evidence }] }
// rubric is general (the default) or a project rubric from team-rubrics.json beside the board (or TEAM_RUBRICS_FILE).
// Default output is <input-basename>.result.json beside the input.
// --dry-run prints the exact request body and exits without calling the API.
// --rescore applies today's weights and holds to a saved result's raw answers, with no API call.
// Needs TYPESAFE_API_KEY (read by the SDK, never printed).
// Run under Node 22.18+, not Bun: @typesafe-ai/sdk 0.7.0 throws "Body already used" on Bun 1.4.4.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { TypeSafeClient } from '@typesafe-ai/sdk'

import {
  DIMENSION_POLICY,
  NO_GOOD,
  RUBRICS,
  THRESHOLDS,
  WEIGHTS,
  buildRequest,
  decide,
  parseInput,
  type Decision,
  type Dimension,
  type Input,
  type RubricName,
} from './jev-decide.lib.ts'
import { hashRequest, receiptPath, toJudgment } from './jev-ask.lib.ts'
import { assertApiKeyAbsent, redactApiKey } from './jev-guard.lib.ts'

const USAGE =
  'usage: node scripts/jev-decide.ts <input.json> [--dry-run] [--out <result.json>] [--model jev-latest] [--force] [--task <id> --by <owner>] | --rescore <result.json> [--out <rescored.json>] [--force]'

// chars/3.5 is a conservative stand-in for jev-1.13 tokens. Refuse before the client exists.
export const MAX_REQUEST_TOKENS = 56_000
export const MAX_QUESTION_TOKENS = 28_000
const CHARS_PER_TOKEN = 3.5

type Args = {
  file: string
  dryRun: boolean
  rescore: boolean
  out?: string
  model: string
  force: boolean
  task?: string
  by?: string
}

function requiredArg(args: string[], index: number): string {
  const arg = args[index]
  if (arg === undefined) throw new Error(USAGE)
  return arg
}

function assertTaskFlags(values: { task?: string; by?: string }, switches: { dryRun: boolean; rescore: boolean }) {
  if (values.task && !values.by) throw new Error(`--task needs --by <owner>\n${USAGE}`)
  if (values.by && !values.task) throw new Error(`--by needs --task <id>\n${USAGE}`)
  if (values.task && (switches.dryRun || switches.rescore))
    throw new Error(`--task cannot be used with --dry-run or --rescore\n${USAGE}`)
  if (values.by) refuseDecideBy(values.by)
}

function refuseDecideBy(by: string) {
  const plain = by
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Mn}]/gu, '')
    .trim()
    .toLowerCase()
  if (plain === 'jev') throw new Error(`by jev is reserved for verdicts\n${USAGE}`)
}

const SWITCHES = { '--dry-run': 'dryRun', '--rescore': 'rescore', '--force': 'force' } as const
const VALUED = { '--out': 'out', '--model': 'model', '--task': 'task', '--by': 'by' } as const

export function parseArgs(args: string[]): Args {
  const switches = { dryRun: false, rescore: false, force: false }
  const values: { out?: string; model: string; task?: string; by?: string } = { model: 'jev-latest' }
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = requiredArg(args, i)
    if (Object.hasOwn(SWITCHES, arg)) switches[SWITCHES[arg as keyof typeof SWITCHES]] = true
    else if (Object.hasOwn(VALUED, arg)) {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`)
      values[VALUED[arg as keyof typeof VALUED]] = value
      i++
    } else if (arg.startsWith('--')) throw new Error(`${USAGE}`)
    else positionals.push(arg)
  }
  if (positionals.length !== 1) throw new Error(USAGE)
  if (switches.rescore && switches.dryRun) throw new Error(`--rescore and --dry-run cannot be used together\n${USAGE}`)
  assertTaskFlags(values, switches)
  return {
    file: requiredArg(positionals, 0),
    ...switches,
    out: values.out,
    model: values.model,
    ...(values.task ? { task: values.task } : {}),
    ...(values.by ? { by: values.by } : {}),
  }
}

export function formatFailure(err: unknown): string {
  const e = err as { name?: string; message?: string; status?: number }
  const message = redactApiKey(e.message ?? String(err))
  return `jev-decide failed: ${e.name ?? 'Error'}${e.status ? ` ${e.status}` : ''}: ${message}`
}

export function estimateTokens(request: { state: unknown; questions: object }): {
  requestTokens: number
  maxQuestionTokens: number
} {
  const requestTokens = JSON.stringify(request).length / CHARS_PER_TOKEN
  let maxQuestionTokens = 0
  for (const question of Object.values(request.questions)) {
    const tokens = JSON.stringify({ state: request.state, question }).length / CHARS_PER_TOKEN
    if (tokens > maxQuestionTokens) maxQuestionTokens = tokens
  }
  return { requestTokens, maxQuestionTokens }
}

function assertTokenBudget(est: { requestTokens: number; maxQuestionTokens: number }) {
  if (est.requestTokens > MAX_REQUEST_TOKENS || est.maxQuestionTokens > MAX_QUESTION_TOKENS) {
    throw new Error(
      `request is about ${Math.round(est.requestTokens)} tokens and the largest question is about ${Math.round(est.maxQuestionTokens)} tokens; shorten the evidence or split the options`,
    )
  }
}

function assertResultPath(out: string, inputPath: string, force: boolean) {
  if (resolve(out) === resolve(inputPath)) throw new Error('refusing to overwrite the input; choose a different --out')
  if (existsSync(out)) {
    if (statSync(out).isDirectory()) throw new Error(`${out} is a directory`)
    if (!force) throw new Error(`${out} already exists; pass --force to overwrite`)
  }
  const parent = dirname(out)
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    throw new Error(`output directory does not exist: ${parent}`)
}

function printReport(input: Input, d: Decision, model: string, usage: unknown) {
  if (d.holds.some((hold) => hold.startsWith('malformed answer'))) {
    console.log(`model ${model}  usage ${JSON.stringify(usage)}`)
    console.log(`\nRecommendation: ${d.recommendation}`)
    for (const hold of d.holds) console.log(`  hold: ${hold}`)
    return
  }
  const fmt = (x: number) => x.toFixed(2)
  const dist = (p: Record<string, number>) => `[${Object.values(p).map(fmt).join(' ')}]`
  console.log(`model ${model}  usage ${JSON.stringify(usage)}`)
  console.log(`decision: ${input.decision}\n`)
  console.log('Raw Scores (score on 0..3, confidence, P(level 0..3), then the 0..1 value the composite uses):')
  for (const o of d.options) {
    console.log(`  ${o.id}: ${o.title}`)
    for (const [dim, raw] of Object.entries(o.dimensions)) {
      const a = raw as { score: number; confidence: number; probabilities: Record<string, number> } & Record<
        string,
        number
      >
      const key = DIMENSION_POLICY[dim as Dimension].weight
      const weighted = a[key] ?? 0
      console.log(
        `    ${dim.padEnd(9)} score ${fmt(a.score)}  conf ${fmt(a.confidence)}  p=${dist(a.probabilities)}  ${key} ${fmt(weighted)}`,
      )
    }
  }
  const w = Object.entries(WEIGHTS)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
  console.log(`\nComposite ranking (${w}):`)
  for (const r of d.ranking) {
    const uncertain = r.flags.length ? `  uncertain: ${r.flags.join(', ')}` : ''
    console.log(`  ${r.rank}. ${r.id.padEnd(28)} ${r.composite.toFixed(3)}${uncertain}`)
  }
  console.log('\nFirst-step Choice probabilities (forward | reversed order | mean):')
  for (const [label, p] of Object.entries(d.choice.mean.probabilities)) {
    const forward = d.choice.forward.probabilities[label] ?? 0
    const reversed = d.choice.reversed.probabilities[label] ?? 0
    console.log(`  ${label.padEnd(28)} ${fmt(forward)} | ${fmt(reversed)} | ${fmt(p)}`)
  }
  console.log(
    `  picks: forward ${d.choice.forward.pick} (conf ${fmt(d.choice.forward.confidence)}), reversed ${d.choice.reversed.pick} (conf ${fmt(d.choice.reversed.confidence)}), mean ${d.choice.mean.pick} (conf ${fmt(d.choice.mean.confidence)}); order-consistent ${d.choice.orderConsistent}`,
  )
  console.log(`  companion Noul any_sound: ${fmt(d.anySound)}`)
  console.log(`\nRecommendation: ${d.recommendation}  (composite top ${d.compositeTop}, Choice top ${d.choiceTop})`)
  for (const h of d.holds) console.log(`  hold: ${h}`)
}

export function resultPath(inputPath: string, out: string | undefined): string {
  if (out) return resolve(out)
  const base = basename(inputPath).replace(/\.json$/i, '')
  return join(dirname(inputPath), `${base}.result.json`)
}

type SavedResult = {
  rubric?: string
  model?: string
  usage?: unknown
  rawAnswers?: unknown
  request?: {
    state?: { decision?: unknown; context?: unknown }
    questions?: { first_step?: { criteria?: Record<string, Record<string, unknown>> } }
  }
}

/** Rebuilds the input a saved result was asked with. Results saved without a rubric rescore under the general rubric. */
export function inputFromResult(saved: SavedResult): Input {
  const criteria = saved.request?.questions?.first_step?.criteria
  if (!criteria || !saved.rawAnswers) throw new Error('result has no request or raw answers to rescore')
  const rubric = (saved.rubric ?? 'general') as RubricName
  if (!Object.hasOwn(RUBRICS, rubric)) throw new Error(`result names unknown rubric ${JSON.stringify(rubric)}`)
  const state = saved.request?.state
  const options = Object.entries(criteria)
    .filter(([id]) => id !== NO_GOOD)
    .map(([id, o]) => ({
      id,
      title: String(o.title),
      description: String(o.description),
      evidence: String(o.evidence),
    }))
  return parseInput({ decision: state?.decision, context: state?.context ?? '', rubric, options }).input
}

function rescore(resultFile: string, args: Args) {
  const saved = JSON.parse(readFileSync(resultFile, 'utf8')) as SavedResult
  const input = inputFromResult(saved)
  const decision = decide(input, saved.rawAnswers)
  printReport(input, decision, saved.model ?? 'saved', saved.usage)
  if (!args.out) return
  const out = resolve(args.out)
  assertResultPath(out, resultFile, args.force)
  const result = {
    rescoredAt: new Date().toISOString(),
    from: resultFile,
    weights: WEIGHTS,
    thresholds: THRESHOLDS,
    rubric: input.rubric,
    ...decision,
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`\nwrote ${out}`)
}

// A paid response is never discarded: a throwing scorer is reported after the result is written.
function scoreSafely(score: (input: Input, answers: unknown) => Decision, input: Input, answers: unknown) {
  try {
    return { decision: score(input, answers), failure: undefined }
  } catch (failure) {
    return { decision: undefined, failure: failure ?? new Error('decide threw') }
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: { decide?: (input: Input, answers: unknown) => Decision } = {},
): Promise<void> {
  const args = parseArgs(argv)
  const inputPath = resolve(args.file)
  if (args.rescore) return rescore(inputPath, args)
  const { input, warnings } = parseInput(JSON.parse(readFileSync(inputPath, 'utf8')))
  for (const w of warnings) console.warn(`warning: ${w}`)
  const request = buildRequest(input)
  assertApiKeyAbsent(request)
  const estimates = estimateTokens(request)
  assertTokenBudget(estimates)
  if (args.dryRun) {
    console.log(JSON.stringify(request, null, 2))
    console.error(
      `dry run: ${Object.keys(request.questions).length} questions, ${JSON.stringify(request).length} chars; about ${Math.round(estimates.requestTokens)} request tokens, about ${Math.round(estimates.maxQuestionTokens)} question tokens; nothing sent`,
    )
    return
  }
  if (args.task) assertDecideTask(args.task, args.by)
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('TYPESAFE_API_KEY is not set')
  const out = resultPath(inputPath, args.out)
  assertResultPath(out, inputPath, args.force)
  const client = new TypeSafeClient({ defaultModel: args.model }) // Reads TYPESAFE_API_KEY; never log it.
  const response = await client.systemOne(request)
  const { decision, failure } = scoreSafely(deps.decide ?? decide, input, response.answers)
  const result = {
    generatedAt: new Date().toISOString(),
    input: inputPath,
    sdk: import.meta.resolve('@typesafe-ai/sdk'),
    requestedModel: args.model,
    model: response.model,
    usage: response.usage,
    weights: WEIGHTS,
    thresholds: THRESHOLDS,
    rubric: input.rubric,
    ...decision,
    rawAnswers: response.answers,
    request,
    ...(failure ? { error: formatFailure(failure) } : {}),
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
  finishScored(args, input, request, response, decision, failure, out)
}

function finishScored(
  args: Args,
  input: Input,
  request: unknown,
  response: { answers: unknown; model: string; usage: unknown },
  decision: Decision | undefined,
  failure: unknown,
  out: string,
) {
  if (decision) printReport(input, decision, response.model, response.usage)
  console.log(`\nwrote ${out}`)
  if (args.task && decision) recordDecide(args, input, request, response.answers, decision)
  if (failure) throw failure
}

function finiteUnit(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

const boardScript = () => join(dirname(fileURLToPath(import.meta.url)), 'team-tasks.mjs')

// The board refuses the judgment on a missing task, or on a gated task that --by does not own; refuse it
// here, before paying for the call.
function assertDecideTask(id: string, by: string | undefined) {
  let shown: string
  try {
    shown = execFileSync(process.execPath, [boardScript(), 'show', id], {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error(`task ${id} does not exist or the board could not be read`)
  }
  const task = JSON.parse(shown) as { id?: number; accept?: string; status?: string; owner?: string } | null
  if (!task || task.id !== Number(id)) throw new Error(`task ${id} does not exist`)
  if (task.status === 'done' || task.status === 'cancelled') throw new Error(`task ${id} is ${task.status}`)
  if (!task.accept) return
  if (task.status !== 'claimed') throw new Error(`task ${id} is ${task.status}; a gated task needs a claim first`)
  if (task.owner !== by) throw new Error(`task ${id} is claimed by ${task.owner}; --by must be the owner`)
}

function recordDecide(args: Args, input: Input, request: unknown, answers: unknown, decision: Decision) {
  const task = args.task
  const by = args.by
  if (!task || !by) return
  const requestHash = hashRequest(request)
  const receipt = receiptPath(resolveBoardFile(), task, 'decide', requestHash)
  const answered = decision.holds.length === 0
  const outcome = {
    outcome: answered ? ('answered' as const) : ('hold' as const),
    answer: answered ? decision.recommendation : null,
    p: answered ? finiteUnit(decision.choice.mean.probabilities[decision.recommendation]) : null,
    confidence: finiteUnit(decision.choice.mean.confidence),
    reasons: decision.holds,
  }
  mkdirSync(dirname(receipt), { recursive: true })
  const body = { ...outcome, request, answers, thresholds: THRESHOLDS, requestHash }
  writeFileSync(receipt, `${JSON.stringify(body, null, 2)}\n`)
  const question = input.decision.trim().slice(0, 300)
  const payload = toJudgment('decide', outcome, {
    by,
    question,
    requestHash,
    receipt,
    ...(answers && typeof answers === 'object' ? { answers } : {}),
  })
  execFileSync(process.execPath, [boardScript(), 'judgment', task, JSON.stringify(payload)], {
    env: process.env,
    encoding: 'utf8',
  })
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    console.error(formatFailure(err))
    process.exitCode = 1
  })
}
