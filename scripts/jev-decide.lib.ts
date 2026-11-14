// One Jev call scores fix or approach options. Weights, thresholds, and the verdict live here.
// Each Score sees only its own option. The Choice sees every option, plus an order-reversed copy
// that measures position bias in the same call. A companion Noul checks "any reasonable first step"
// because a none-of-the-above label often underperforms on its own.
import { choice, noul, score, type Question } from '@typesafe-ai/sdk'

import { cleanText } from './jev-guard.lib.ts'

// Composite weights over 0..1 normalized dimensions; they sum to 1.
// Evidence leads: a first step that is not shown to work wastes a verification cycle.
// Regression safety next: a fix that breaks what works today costs more than it saves.
// Value next, then cost: a cheap step that changes nothing anyone notices is a poor first step.
export const WEIGHTS = { evidence: 0.4, safety: 0.25, value: 0.2, cheapness: 0.15 } as const

// Starting values; tune against real outcomes. Confidence summarizes how peaked a distribution is,
// not whether the answer is right.
export const THRESHOLDS = {
  minDimensionConfidence: 0.5, // a Score below this is flagged as uncertain
  minChoiceConfidence: 0.5, // computed from the order-averaged Choice distribution
  minAnySound: 0.5, // companion Noul; below this Jev leans "no option is a sound first step"
  minCompositeMargin: 0.05, // the top composite must beat the runner-up by this much
} as const

const MAX_OPTIONS = 12
export const NO_GOOD = 'no_good_option'

type WeightKey = keyof typeof WEIGHTS
export type Dimension = 'evidence' | 'risk' | 'cost' | 'value'

// Levels describe situations in their natural direction; code inverts risk and cost.
export const DIMENSION_POLICY: Record<Dimension, { inverse: boolean; weight: WeightKey }> = {
  evidence: { inverse: false, weight: 'evidence' },
  risk: { inverse: true, weight: 'safety' },
  cost: { inverse: true, weight: 'cheapness' },
  value: { inverse: false, weight: 'value' },
}

// An uncertain evidence or risk Score on the top option holds: those decide whether the pick is safe.
// An uncertain cost or value Score is reported as a flag; it changes the ranking, not whether to act.
export const HOLD_ON_UNCERTAIN: readonly Dimension[] = ['evidence', 'risk']

type DimensionText = { question: string; levels: readonly [string, string, string, string] }
type OptionRecord = { title: string; description: string; evidence: string }
type RubricText = {
  dimensions: Record<Dimension, DimensionText>
  noGood: OptionRecord
  anySound: { true: string; false: string }
}

// general fits any engineering decision. Every rubric has four levels per dimension so saved answers rescore under it.
export const RUBRICS = {
  general: {
    dimensions: {
      evidence: {
        question:
          'How strongly does the evidence in `option.evidence` show that carrying out `option.description` achieves what `decision` asks for?',
        levels: [
          'Untested: the evidence is a hypothesis, a plausible mechanism, or a measurement of something else',
          'The evidence measures the problem this option targets but does not test whether the option solves it',
          'The option was tried, in a prototype, test, replay, or partial run, and worked in some cases or one condition',
          'The option was tried and worked in every case the decision covers',
        ],
      },
      risk: {
        question:
          'If `option.description` ships, how much could it change behavior that works today for users, callers, or other parts of the system?',
        levels: [
          'Contained: it adds a check, a message, or new code behind a gate, so existing behavior stays the same',
          'Narrow: it changes shared code for a small, named set of callers or flows',
          'Broad: it changes a shared contract, threshold, or rule that most callers pass through',
          'Core: it changes persisted data, auth, or a path every request or session goes through',
        ],
      },
      cost: {
        question: 'How much work does it take to implement `option.description` and verify that it works?',
        levels: [
          'Small: one module, verified with existing tests in about a day',
          'Moderate: a few files in one package, plus new tests or fixtures',
          'Large: spans packages, UI, or native code, or needs a device pass to verify',
          'Very large: needs new data, a migration, a new dependency, or a retrained model before it can be verified',
        ],
      },
      value: {
        question: 'Once `option.description` ships, how much better is the result for the people it serves?',
        levels: [
          'Nothing visible: no user or developer would notice a change',
          'Minor: it helps a rare edge case, or only improves internal diagnostics',
          'Clear: users or developers in a common situation get a noticeably better result',
          'Major: it removes a frequent, trust-breaking failure for most users or developers',
        ],
      },
    },
    noGood: {
      title: 'No good option',
      description:
        'None of the other options is a sound first step: each lacks evidence that it works, risks breaking what works today, or does not address `decision`',
      evidence: 'Not an option to carry out',
    },
    anySound: {
      true: 'At least one option addresses the decision, has some supporting evidence, and does not obviously risk what works today',
      false: 'Every option is unsupported, off target, or likely to break what works today',
    },
  },
} as const satisfies Record<string, RubricText>
export type RubricName = keyof typeof RUBRICS
export const DEFAULT_RUBRIC: RubricName = 'general'

const DIMENSION_NAMES = Object.keys(DIMENSION_POLICY) as Dimension[]
const MAX_SCORE = 3

const FIRST_STEP_QUESTION = 'Which option should be the first step toward `decision`, given `context`?'

export type Option = { id: string; title: string; description: string; evidence: string }
export type Input = { decision: string; context: string; rubric: RubricName; options: Option[] }

type ScoreAnswer = { score: number; confidence: number; probabilities: Record<string, number> }
type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> }
export type Answers = Record<string, ScoreAnswer | ChoiceAnswer | { noul: number }>

export type Decision = {
  options: {
    id: string
    title: string
    dimensions: Record<string, unknown>
    composite: number
    flags: string[]
    holdFlags: string[]
  }[]
  ranking: { rank: number; id: string; composite: number; flags: string[] }[]
  choice: {
    forward: { pick: string; confidence: number; probabilities: Record<string, number> }
    reversed: { pick: string; confidence: number; probabilities: Record<string, number> }
    mean: { pick: string; confidence: number; probabilities: Record<string, number> }
    orderConsistent: boolean
  }
  anySound: number
  recommendation: string
  compositeTop: string
  choiceTop: string
  holds: string[]
}

function warnExtraKeys(obj: Record<string, unknown>, allowed: string[], where: string, warnings: string[]) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) warnings.push(`dropped ${where}.${key} (not sent)`)
}

export function parseInput(raw: unknown): { input: Input; warnings: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be a JSON object')
  const obj = raw as Record<string, unknown>
  const warnings: string[] = []
  warnExtraKeys(obj, ['decision', 'context', 'rubric', 'options'], 'input', warnings)
  const rubric = obj.rubric ?? DEFAULT_RUBRIC
  if (typeof rubric !== 'string' || !Object.hasOwn(RUBRICS, rubric))
    throw new Error(`rubric must be one of ${Object.keys(RUBRICS).join(', ')}`)
  if (!Array.isArray(obj.options) || obj.options.length < 2 || obj.options.length > MAX_OPTIONS) {
    throw new Error(`options must be an array of 2 to ${MAX_OPTIONS} entries`)
  }
  const seen = new Set<string>()
  const options = obj.options.map((entry: unknown, i: number): Option => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`options[${i}] must be an object`)
    const o = entry as Record<string, unknown>
    warnExtraKeys(o, ['id', 'title', 'description', 'evidence'], `options[${i}]`, warnings)
    const id = cleanText(o.id, `options[${i}].id`)
    // Starts with a letter so JS never reorders it as an integer key; the id is a Choice label Jev sees.
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(id)) throw new Error(`options[${i}].id must match ^[a-z][a-z0-9_]{0,47}$`)
    if (id === NO_GOOD || seen.has(id)) throw new Error(`options[${i}].id "${id}" is reserved or duplicated`)
    seen.add(id)
    return {
      id,
      title: cleanText(o.title, `options[${i}].title`),
      description: cleanText(o.description, `options[${i}].description`),
      evidence: cleanText(o.evidence, `options[${i}].evidence`),
    }
  })
  return {
    input: {
      decision: cleanText(obj.decision, 'decision'),
      context: cleanText(obj.context ?? '', 'context', true),
      rubric: rubric as RubricName,
      options,
    },
    warnings,
  }
}

const optionRecord = (o: Option): OptionRecord => ({ title: o.title, description: o.description, evidence: o.evidence })
const questionId = (dim: Dimension, id: string) => `${dim}__${id}`

// State holds only the shared decision. Each Score carries its own option in `instructions`, so no
// option's Score sees the others; the Choice sees all of them through its labels.
export function buildRequest(input: Input) {
  const rubric: RubricText = RUBRICS[input.rubric]
  const questions: Record<string, Question> = {}
  for (const o of input.options) {
    for (const dim of DIMENSION_NAMES) {
      const text = rubric.dimensions[dim]
      questions[questionId(dim, o.id)] = score({ question: text.question, option: optionRecord(o) }, [...text.levels])
    }
  }
  const labels: Record<string, OptionRecord> = Object.fromEntries([
    ...input.options.map((o) => [o.id, optionRecord(o)]),
    [NO_GOOD, rubric.noGood],
  ])
  const reversedLabels: Record<string, OptionRecord> = Object.fromEntries(Object.entries(labels).reverse())
  // Jev 1.13 leans toward the first Choice option; the reversed copy measures that bias in the same call.
  questions.first_step = choice(FIRST_STEP_QUESTION, labels)
  questions.first_step_reversed = choice(FIRST_STEP_QUESTION, reversedLabels)
  // Docs: a none-of-the-above label often underperforms, so a companion Noul checks it independently.
  questions.any_sound = noul(
    {
      question: 'Is at least one entry in `options` a reasonable first step toward `decision`?',
      options: input.options.map(optionRecord),
    },
    rubric.anySound,
  )
  return { state: { decision: input.decision, context: input.context }, questions }
}

const round = (x: number, digits = 3) => Number(x.toFixed(digits))

// Docs' Choice confidence: how far the top probability sits above an even split.
// n is the expected label count (options plus no_good_option), not the keys the model returned.
const choiceConfidence = (pTop: number, n: number) => (pTop - 1 / n) / (1 - 1 / n)

const expectedLabels = (input: Input) => [...input.options.map((o) => o.id), NO_GOOD]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function finiteProbabilities(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).every((p) => typeof p === 'number' && Number.isFinite(p))
}

function sameLabelProbabilities(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== expected.length) return false
  const want = new Set(expected)
  for (const key of keys) {
    if (!want.has(key) || !finiteIn(value[key], 0, 1)) return false
  }
  return true
}

function scoreAnswerOk(answer: unknown, maxScore: number): boolean {
  if (!isRecord(answer)) return false
  if (!finiteIn(answer.score, 0, maxScore) || !finiteIn(answer.confidence, 0, 1)) return false
  return finiteProbabilities(answer.probabilities)
}

function choiceAnswerOk(answer: unknown, labels: readonly string[]): boolean {
  if (!isRecord(answer) || typeof answer.choice !== 'string') return false
  if (!labels.includes(answer.choice) || !finiteIn(answer.confidence, 0, 1)) return false
  return sameLabelProbabilities(answer.probabilities, labels)
}

// Missing, non-finite, or out-of-range fields become holds. Nothing here throws.
export function validateAnswers(input: Input, answers: unknown): string[] {
  const holds: string[] = []
  const bag = isRecord(answers) ? answers : {}
  const labels = expectedLabels(input)
  for (const o of input.options) {
    for (const dim of DIMENSION_NAMES) {
      const qid = questionId(dim, o.id)
      if (!scoreAnswerOk(bag[qid], MAX_SCORE)) holds.push(`malformed answer ${qid}`)
    }
  }
  for (const qid of ['first_step', 'first_step_reversed'] as const) {
    if (!choiceAnswerOk(bag[qid], labels)) holds.push(`malformed answer ${qid}`)
  }
  const anySound = bag.any_sound
  if (!isRecord(anySound) || !finiteIn(anySound.noul, 0, 1)) holds.push('malformed answer any_sound')
  return holds
}

function policyHolds(input: {
  meanTop: string
  anySound: number
  orderConsistent: boolean
  forwardPick: string
  reversedPick: string
  meanConfidence: number
  compositeTopId: string
  margin: number
  holdFlags: string[]
}): string[] {
  const holds: string[] = []
  if (input.meanTop === NO_GOOD) holds.push('Choice picks no_good_option')
  if (input.anySound < THRESHOLDS.minAnySound) {
    holds.push(`any_sound ${input.anySound.toFixed(2)} below ${THRESHOLDS.minAnySound}`)
  }
  if (!input.orderConsistent) {
    holds.push(`Choice flips with option order (${input.forwardPick} vs ${input.reversedPick})`)
  }
  if (input.meanConfidence < THRESHOLDS.minChoiceConfidence) {
    holds.push(`Choice confidence ${input.meanConfidence.toFixed(2)} below ${THRESHOLDS.minChoiceConfidence}`)
  }
  if (input.meanTop !== input.compositeTopId) {
    holds.push(`composite top ${input.compositeTopId} differs from Choice top ${input.meanTop}`)
  }
  if (input.margin < THRESHOLDS.minCompositeMargin) {
    holds.push(`composite margin ${input.margin.toFixed(3)} below ${THRESHOLDS.minCompositeMargin}`)
  }
  if (input.holdFlags.length) holds.push(`top option has uncertain scores: ${input.holdFlags.join(', ')}`)
  return holds
}

function heldDecision(input: Input, holds: string[]): Decision {
  const options = input.options.map((o) => ({
    id: o.id,
    title: o.title,
    dimensions: {},
    composite: Number.NaN,
    flags: [] as string[],
    holdFlags: [] as string[],
  }))
  return {
    options,
    ranking: options.map((o, i) => ({ rank: i + 1, id: o.id, composite: Number.NaN, flags: [] })),
    choice: {
      forward: { pick: '', confidence: Number.NaN, probabilities: {} },
      reversed: { pick: '', confidence: Number.NaN, probabilities: {} },
      mean: { pick: '', confidence: Number.NaN, probabilities: {} },
      orderConsistent: false,
    },
    anySound: Number.NaN,
    recommendation: 'needs_lead',
    compositeTop: '',
    choiceTop: '',
    holds,
  }
}

export function decide(input: Input, answers: unknown): Decision {
  const problems = validateAnswers(input, answers)
  if (problems.length) return heldDecision(input, problems)
  const checked = answers as Answers

  const options = input.options.map((o) => {
    let composite = 0
    const flags: string[] = []
    const holdFlags: string[] = []
    const dimensions: Record<string, unknown> = {}
    for (const dim of DIMENSION_NAMES) {
      const policy = DIMENSION_POLICY[dim]
      const a = checked[questionId(dim, o.id)] as ScoreAnswer
      const fraction = a.score / MAX_SCORE
      const normalized = policy.inverse ? 1 - fraction : fraction
      composite += WEIGHTS[policy.weight] * normalized
      if (a.confidence < THRESHOLDS.minDimensionConfidence) {
        const flag = `${dim} confidence ${a.confidence.toFixed(2)}`
        flags.push(flag)
        if (HOLD_ON_UNCERTAIN.includes(dim)) holdFlags.push(flag)
      }
      dimensions[dim] = {
        score: a.score,
        maxScore: MAX_SCORE,
        confidence: a.confidence,
        probabilities: a.probabilities,
        [policy.weight]: round(normalized),
      }
    }
    return { id: o.id, title: o.title, dimensions, composite: round(composite), flags, holdFlags }
  })
  const ranking = [...options].sort((a, b) => b.composite - a.composite)
  const compositeTop = ranking[0]
  if (!compositeTop) return heldDecision(input, ['malformed answer options'])

  const forward = checked.first_step as ChoiceAnswer
  const reversed = checked.first_step_reversed as ChoiceAnswer
  const labels = expectedLabels(input)
  const mean = Object.fromEntries(
    labels.map((l) => [l, round(((forward.probabilities[l] ?? 0) + (reversed.probabilities[l] ?? 0)) / 2)]),
  )
  const meanTopEntry = Object.entries(mean).sort((a, b) => b[1] - a[1])[0]
  if (!meanTopEntry) return heldDecision(input, ['malformed answer first_step'])
  const [meanTop, meanTopP] = meanTopEntry
  const meanConfidence = round(choiceConfidence(meanTopP, labels.length))
  const orderConsistent = forward.choice === reversed.choice
  const anySound = (checked.any_sound as { noul: number }).noul
  const runnerUp = ranking[1]
  const margin = round(compositeTop.composite - (runnerUp?.composite ?? 0))
  const holds = policyHolds({
    meanTop,
    anySound,
    orderConsistent,
    forwardPick: forward.choice,
    reversedPick: reversed.choice,
    meanConfidence,
    compositeTopId: compositeTop.id,
    margin,
    holdFlags: compositeTop.holdFlags,
  })

  return {
    options,
    ranking: ranking.map((o, i) => ({ rank: i + 1, id: o.id, composite: o.composite, flags: o.flags })),
    choice: {
      forward: { pick: forward.choice, confidence: forward.confidence, probabilities: forward.probabilities },
      reversed: { pick: reversed.choice, confidence: reversed.confidence, probabilities: reversed.probabilities },
      mean: { pick: meanTop, confidence: meanConfidence, probabilities: mean },
      orderConsistent,
    },
    anySound,
    recommendation: holds.length ? 'needs_lead' : compositeTop.id,
    compositeTop: compositeTop.id,
    choiceTop: meanTop,
    holds,
  }
}
