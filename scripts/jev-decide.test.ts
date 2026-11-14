import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tailText } from './jev-guard.lib.ts'
import { estimateTokens, formatFailure, inputFromResult, main, parseArgs, resultPath } from './jev-decide.ts'
import {
  DIMENSION_POLICY,
  NO_GOOD,
  RUBRICS,
  THRESHOLDS,
  WEIGHTS,
  buildRequest,
  decide,
  parseInput,
  type Answers,
  type Dimension,
  type Input,
} from './jev-decide.lib.ts'

const sdkMock = vi.hoisted(() => ({
  constructed: [] as unknown[],
  systemOne: vi.fn(),
}))

vi.mock('@typesafe-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@typesafe-ai/sdk')>('@typesafe-ai/sdk')
  class TypeSafeClient {
    constructor(config: unknown) {
      sdkMock.constructed.push(config)
    }
    systemOne(request: unknown) {
      return sdkMock.systemOne(request)
    }
  }
  return { ...actual, TypeSafeClient }
})

const option = (id: string, over: Partial<Input['options'][number]> = {}) => ({
  id,
  title: `${id} title`,
  description: `${id} description of the change`,
  evidence: `${id} evidence is a short summary`,
  ...over,
})

const sample = (): Input => ({
  decision: 'Choose the first fix for the flaky retry loop',
  context: 'Other jobs retry correctly today',
  rubric: 'general',
  options: [option('alpha'), option('beta')],
})

const probs = { '0': 1, '1': 0, '2': 0, '3': 0 }

type DimScore = { score: number; confidence?: number }

function firstOptionId(input: Input): string {
  const first = input.options[0]
  if (!first) throw new Error('fixture needs an option')
  return first.id
}

function answersFor(
  input: Input,
  scores: Record<string, Partial<Record<Dimension, DimScore>>>,
  over: {
    forward?: string
    reversed?: string
    forwardP?: Record<string, number>
    reversedP?: Record<string, number>
    anySound?: number
  } = {},
): Answers {
  const answers: Answers = {}
  for (const o of input.options) {
    for (const dim of Object.keys(DIMENSION_POLICY) as Dimension[]) {
      const cell = scores[o.id]?.[dim] ?? { score: 0, confidence: 1 }
      answers[`${dim}__${o.id}`] = {
        score: cell.score,
        confidence: cell.confidence ?? 1,
        probabilities: probs,
      }
    }
  }
  const labels = [...input.options.map((o) => o.id), NO_GOOD]
  const pick = firstOptionId(input)
  const peaked = Object.fromEntries(labels.map((id) => [id, id === pick ? 0.9 : 0.05]))
  answers.first_step = {
    choice: over.forward ?? pick,
    confidence: 0.9,
    probabilities: over.forwardP ?? peaked,
  }
  answers.first_step_reversed = {
    choice: over.reversed ?? pick,
    confidence: 0.9,
    probabilities: over.reversedP ?? peaked,
  }
  answers.any_sound = { noul: over.anySound ?? 0.9 }
  return answers
}

const previousKey = process.env.TYPESAFE_API_KEY

beforeEach(() => {
  sdkMock.constructed.length = 0
  sdkMock.systemOne.mockReset()
})

afterEach(() => {
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = previousKey
})

function optionAt(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  if (!Array.isArray(raw.options)) throw new Error('fixture needs options')
  const entry = raw.options[index]
  if (!entry || typeof entry !== 'object') throw new Error('fixture needs an option')
  return entry as Record<string, unknown>
}

describe('tailText', () => {
  it('keeps the end of a string and leaves a short one unchanged', () => {
    expect(tailText('abcdef', 3)).toBe('def')
    expect(tailText('ab', 3)).toBe('ab')
    expect(tailText('abcdef', 0)).toBe('')
  })
})

describe('parseInput privacy', () => {
  const base = () => structuredClone(sample()) as Input & { extra?: unknown }

  it.each([
    ['decision', (raw: Record<string, unknown>) => (raw.decision = 1), 'decision must be a string'],
    ['context', (raw: Record<string, unknown>) => (raw.context = 1), 'context must be a string'],
    ['title', (raw: Record<string, unknown>) => (optionAt(raw, 0).title = null), 'options[0].title must be a string'],
    [
      'description',
      (raw: Record<string, unknown>) => (optionAt(raw, 0).description = ['x']),
      'options[0].description must be a string',
    ],
    [
      'evidence',
      (raw: Record<string, unknown>) => (optionAt(raw, 0).evidence = { n: 1 }),
      'options[0].evidence must be a string',
    ],
  ])('refuses a non-string %s', (_name, mutate, message) => {
    const raw = base()
    mutate(raw)
    expect(() => parseInput(raw)).toThrow(message)
  })

  it('refuses empty text, oversized text, image data, a numeric run, and an email', () => {
    const numbers = Array.from({ length: 24 }, (_, i) => String(i)).join(' ')
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base(), decision: '   ' }, 'decision is empty'],
      [{ ...base(), decision: 'd'.repeat(4001) }, 'decision is over 4000 characters'],
      [{ ...base(), context: 'see data:image/png;base64,aaaa' }, 'context looks like embedded binary or image data'],
      [{ ...base(), decision: 'A'.repeat(200) }, 'decision looks like embedded binary or image data'],
      [
        { ...base(), options: [option('alpha', { evidence: numbers }), option('beta')] },
        'options[0].evidence has a long run of numbers',
      ],
      [
        { ...base(), options: [option('alpha', { title: 'mail me at alice@example.com' }), option('beta')] },
        'options[0].title contains an email address',
      ],
    ]
    for (const [raw, message] of cases) expect(() => parseInput(raw)).toThrow(message)
  })

  it('allows a numeric run of 23 and a 199-character token', () => {
    const numbers = Array.from({ length: 23 }, (_, i) => String(i)).join(',')
    const raw = base()
    const first = raw.options[0]
    const second = raw.options[1]
    if (!first || !second) throw new Error('fixture needs two options')
    first.evidence = `${numbers} still a summary`
    second.description = 'B'.repeat(199)
    expect(parseInput(raw).input.options[0]?.evidence).toContain('22')
  })

  it('drops unknown fields with a warning and does not put them in the request', () => {
    const raw = {
      ...base(),
      extras: [1, 2, 3],
      options: [{ ...option('alpha'), hint: 'hidden' }, option('beta')],
    }
    const parsed = parseInput(raw)
    expect(parsed.warnings).toEqual(['dropped input.extras (not sent)', 'dropped options[0].hint (not sent)'])
    const sent = JSON.stringify(buildRequest(parsed.input))
    expect(sent).not.toContain('extras')
    expect(sent).not.toContain('hidden')
  })

  it('rejects a bad shape, a reserved or duplicate id, and the wrong option count', () => {
    expect(() => parseInput(null)).toThrow('input must be a JSON object')
    expect(() => parseInput([])).toThrow('input must be a JSON object')
    expect(() => parseInput({ ...base(), options: [option('alpha')] })).toThrow('options must be an array of 2 to 12')
    expect(() => parseInput({ ...base(), options: Array.from({ length: 13 }, (_, i) => option(`opt${i}`)) })).toThrow(
      'options must be an array of 2 to 12',
    )
    expect(() => parseInput({ ...base(), options: [null, option('beta')] })).toThrow('options[0] must be an object')
    expect(() => parseInput({ ...base(), options: [option('1bad'), option('beta')] })).toThrow('must match')
    expect(() => parseInput({ ...base(), options: [option(NO_GOOD), option('beta')] })).toThrow(
      'reserved or duplicated',
    )
    expect(() => parseInput({ ...base(), options: [option('alpha'), option('alpha')] })).toThrow(
      'reserved or duplicated',
    )
  })

  it('allows an omitted context and trims fields', () => {
    const raw = base()
    delete (raw as { context?: string }).context
    raw.decision = '  trimmed decision  '
    const parsed = parseInput(raw)
    expect(parsed.input.context).toBe('')
    expect(parsed.input.decision).toBe('trimmed decision')
  })

  it('defaults to the general rubric and refuses an unknown one', () => {
    const raw = base() as Record<string, unknown>
    delete raw.rubric
    expect(parseInput(raw).input.rubric).toBe('general')
    expect(parseInput({ ...raw, rubric: 'general' }).input.rubric).toBe('general')
    expect(parseInput({ ...raw, rubric: 'general' }).warnings).toEqual([])
    expect(() => parseInput({ ...raw, rubric: 'unknown' })).toThrow(/rubric must be one of general/)
    expect(() => parseInput({ ...raw, rubric: 3 })).toThrow(/rubric must be one of/)
  })
})

describe('buildRequest', () => {
  it('asks general questions under the general rubric', () => {
    const request = buildRequest({
      ...sample(),
      decision: 'Choose how queued jobs survive a worker restart',
      context: '',
      rubric: 'general',
    })
    const evidence = request.questions.evidence__alpha as unknown as { criteria: string[] }
    expect(evidence.criteria).toEqual([...RUBRICS.general.dimensions.evidence.levels])
    const choice = request.questions.first_step as unknown as { criteria: Record<string, { description: string }> }
    expect(choice.criteria[NO_GOOD]).toEqual(RUBRICS.general.noGood)
  })

  it('keeps four levels per dimension in every rubric so saved answers rescore', () => {
    for (const rubric of Object.values(RUBRICS))
      for (const text of Object.values(rubric.dimensions)) expect(text.levels).toHaveLength(4)
  })

  it('asks independent Scores, a reversed Choice, and one Noul', () => {
    const input = sample()
    const request = buildRequest(input)
    expect(request.state).toEqual({ decision: input.decision, context: input.context })
    expect(Object.keys(request.questions)).toEqual([
      'evidence__alpha',
      'risk__alpha',
      'cost__alpha',
      'value__alpha',
      'evidence__beta',
      'risk__beta',
      'cost__beta',
      'value__beta',
      'first_step',
      'first_step_reversed',
      'any_sound',
    ])

    const alpha = request.questions.evidence__alpha as {
      type: string
      instructions: { option: unknown }
      criteria: string[]
    }
    const beta = request.questions.evidence__beta as unknown as { instructions: { option: { title: string } } }
    expect(alpha.type).toBe('score')
    expect(alpha.criteria).toEqual([...RUBRICS.general.dimensions.evidence.levels])
    expect(alpha.instructions.option).toEqual({
      title: 'alpha title',
      description: 'alpha description of the change',
      evidence: 'alpha evidence is a short summary',
    })
    expect(JSON.stringify(alpha.instructions)).not.toContain('beta')
    expect(beta.instructions.option.title).toBe('beta title')

    const forward = request.questions.first_step as { type: string; criteria: Record<string, unknown> }
    const reversed = request.questions.first_step_reversed as { criteria: Record<string, unknown> }
    expect(forward.type).toBe('choice')
    expect(Object.keys(forward.criteria)).toEqual(['alpha', 'beta', NO_GOOD])
    expect(Object.keys(reversed.criteria)).toEqual([NO_GOOD, 'beta', 'alpha'])
    expect(forward.criteria[NO_GOOD]).toMatchObject({ title: 'No good option' })

    const anySound = request.questions.any_sound as { type: string; instructions: { options: unknown[] } }
    expect(anySound.type).toBe('noul')
    expect(anySound.instructions.options).toHaveLength(2)
    expect(JSON.stringify(anySound.instructions.options)).not.toContain(NO_GOOD)
  })
})

describe('decide', () => {
  it('weights evidence, inverts risk and cost, and recommends a clear top', () => {
    const input = sample()
    const d = decide(
      input,
      answersFor(input, {
        alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
        beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
      }),
    )
    expect(WEIGHTS).toEqual({ evidence: 0.4, safety: 0.25, value: 0.2, cheapness: 0.15 })
    const alphaOpt = d.options[0]
    const betaOpt = d.options[1]
    if (!alphaOpt || !betaOpt) throw new Error('expected two options')
    const alpha = alphaOpt.dimensions as {
      evidence: { evidence: number }
      risk: { safety: number }
      cost: { cheapness: number }
      value: { value: number }
    }
    const beta = betaOpt.dimensions as { risk: { safety: number }; cost: { cheapness: number } }
    expect(alpha.evidence.evidence).toBe(1)
    expect(alpha.risk.safety).toBe(1)
    expect(alpha.cost.cheapness).toBe(1)
    expect(alpha.value.value).toBe(1)
    expect(beta.risk.safety).toBe(0)
    expect(beta.cost.cheapness).toBe(0)
    expect(d.options.map((o) => o.composite)).toEqual([1, 0])
    expect(d.recommendation).toBe('alpha')
    expect(d.holds).toEqual([])
  })

  it('returns needs_lead when the composite gap is under 0.05', () => {
    const input = sample()
    const d = decide(
      input,
      answersFor(input, {
        alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 0 } },
        beta: { evidence: { score: 2.7 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 0 } },
      }),
    )
    expect(d.ranking.map((r) => r.composite)).toEqual([0.8, 0.76])
    expect(d.recommendation).toBe('needs_lead')
    expect(d.holds).toEqual([`composite margin 0.040 below ${THRESHOLDS.minCompositeMargin}`])
  })

  it('reports a first-step pick that flips with option order', () => {
    const input = sample()
    const peaked = { alpha: 0.96, beta: 0.02, [NO_GOOD]: 0.02 }
    const d = decide(
      input,
      answersFor(
        input,
        {
          alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
          beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
        },
        { forward: 'alpha', reversed: 'beta', forwardP: peaked, reversedP: peaked },
      ),
    )
    expect(d.choice.orderConsistent).toBe(false)
    expect(d.choice.mean.pick).toBe('alpha')
    expect(d.holds).toEqual(['Choice flips with option order (alpha vs beta)'])
    expect(d.recommendation).toBe('needs_lead')
  })

  it('holds no_good_option and a low any-sound judgment', () => {
    const input = sample()
    const clear = {
      alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
      beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
    }
    const none = { alpha: 0.05, beta: 0.05, [NO_GOOD]: 0.9 }
    const noGood = decide(
      input,
      answersFor(input, clear, { forward: NO_GOOD, reversed: NO_GOOD, forwardP: none, reversedP: none }),
    )
    expect(noGood.choiceTop).toBe(NO_GOOD)
    expect(noGood.compositeTop).toBe('alpha')
    expect(noGood.holds).toEqual([
      'Choice picks no_good_option',
      'composite top alpha differs from Choice top no_good_option',
    ])
    expect(noGood.recommendation).toBe('needs_lead')

    const low = decide(input, answersFor(input, clear, { anySound: 0.49 }))
    expect(low.holds).toEqual([`any_sound 0.49 below ${THRESHOLDS.minAnySound}`])
    expect(low.recommendation).toBe('needs_lead')

    const atFloor = decide(input, answersFor(input, clear, { anySound: 0.5 }))
    expect(atFloor.holds).toEqual([])
    expect(atFloor.recommendation).toBe('alpha')
  })

  it('matches the recorded dummy-input composites and margin hold', () => {
    const input: Input = {
      decision: 'Choose the first fix',
      context: 'Dummy',
      rubric: 'general',
      options: [option('camera_setup_check'), option('angle_validity_guard'), option('threshold_tuning')],
    }
    const cell = (score: number, confidence: number) => ({ score, confidence })
    const d = decide(
      input,
      answersFor(
        input,
        {
          camera_setup_check: {
            evidence: cell(0.59, 0.59),
            risk: cell(0, 1),
            cost: cell(1.55, 0.31),
            value: cell(1.47, 0.47),
          },
          angle_validity_guard: {
            evidence: cell(2.21, 0.78),
            risk: cell(2.38, 0.55),
            cost: cell(0.8, 0.72),
            value: cell(1.96, 0.7),
          },
          threshold_tuning: {
            evidence: cell(0.99, 0.99),
            risk: cell(0.8, 0.68),
            cost: cell(0.34, 0.65),
            value: cell(1.8, 0.72),
          },
        },
        {
          forward: 'angle_validity_guard',
          reversed: 'angle_validity_guard',
          forwardP: { camera_setup_check: 0.07, angle_validity_guard: 0.86, threshold_tuning: 0.07, [NO_GOOD]: 0 },
          reversedP: { [NO_GOOD]: 0.01, threshold_tuning: 0.12, angle_validity_guard: 0.83, camera_setup_check: 0.04 },
          anySound: 0.88,
        },
      ),
    )
    expect(d.ranking.map((r) => [r.id, r.composite])).toEqual([
      ['angle_validity_guard', 0.587],
      ['threshold_tuning', 0.568],
      ['camera_setup_check', 0.499],
    ])
    expect(d.choice.mean).toMatchObject({ pick: 'angle_validity_guard', confidence: 0.793 })
    expect(d.recommendation).toBe('needs_lead')
    expect(d.holds).toEqual(['composite margin 0.019 below 0.05'])
    expect(d.ranking[2]?.flags).toEqual(['cost confidence 0.31', 'value confidence 0.47'])
  })

  const decisive = (): Record<string, Partial<Record<Dimension, DimScore>>> => ({
    alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
    beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
  })

  it('holds when mean Choice confidence is under 0.5', () => {
    const input = sample()
    const flat = { alpha: 0.5, beta: 0.3, [NO_GOOD]: 0.2 }
    const d = decide(
      input,
      answersFor(input, decisive(), { forward: 'alpha', reversed: 'alpha', forwardP: flat, reversedP: flat }),
    )
    expect(d.choice.mean.confidence).toBe(0.25)
    expect(d.holds).toEqual(['Choice confidence 0.25 below 0.5'])
    expect(d.recommendation).toBe('needs_lead')
  })

  it('holds when the composite top is not the Choice top', () => {
    const input = sample()
    const peakedBeta = { alpha: 0.05, beta: 0.9, [NO_GOOD]: 0.05 }
    const d = decide(
      input,
      answersFor(input, decisive(), { forward: 'beta', reversed: 'beta', forwardP: peakedBeta, reversedP: peakedBeta }),
    )
    expect(d.holds).toEqual(['composite top alpha differs from Choice top beta'])
    expect(d.recommendation).toBe('needs_lead')
  })

  it('holds when the top option has an uncertain evidence or risk score', () => {
    const input = sample()
    const scores = decisive()
    const alphaScores = scores.alpha
    if (!alphaScores) throw new Error('fixture needs alpha')
    alphaScores.risk = { score: 0, confidence: 0.4 }
    alphaScores.cost = { score: 0, confidence: 0.3 }
    const d = decide(input, answersFor(input, scores))
    expect(d.holds).toEqual(['top option has uncertain scores: risk confidence 0.40'])
    expect(d.recommendation).toBe('needs_lead')
    expect(d.ranking[0]?.flags).toEqual(['risk confidence 0.40', 'cost confidence 0.30'])
  })

  it('flags an uncertain cost or value score on the top option without holding', () => {
    const input = sample()
    const scores = decisive()
    const alphaScores = scores.alpha
    if (!alphaScores) throw new Error('fixture needs alpha')
    alphaScores.cost = { score: 0, confidence: 0.4 }
    alphaScores.value = { score: 3, confidence: 0.2 }
    const d = decide(input, answersFor(input, scores))
    expect(d.holds).toEqual([])
    expect(d.recommendation).toBe('alpha')
    expect(d.ranking[0]?.flags).toEqual(['cost confidence 0.40', 'value confidence 0.20'])
  })

  it('recommends when the composite margin is exactly 0.05', () => {
    const input = sample()
    const d = decide(
      input,
      answersFor(input, {
        alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 0 } },
        beta: { evidence: { score: 2.625 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 0 } },
      }),
    )
    expect(d.ranking.map((r) => r.composite)).toEqual([0.8, 0.75])
    expect(d.holds).toEqual([])
    expect(d.recommendation).toBe('alpha')
  })

  it('returns needs_lead for a malformed answer and does not throw', () => {
    const input = sample()
    const fresh = () => answersFor(input, decisive()) as Record<string, Record<string, unknown>>

    const missingScore = fresh()
    delete missingScore.evidence__alpha?.score
    expect(() => decide(input, missingScore)).not.toThrow()
    expect(decide(input, missingScore).holds).toEqual(['malformed answer evidence__alpha'])
    expect(decide(input, missingScore).recommendation).toBe('needs_lead')

    const missingConfidence = fresh()
    delete missingConfidence.evidence__alpha?.confidence
    expect(decide(input, missingConfidence).holds).toEqual(['malformed answer evidence__alpha'])

    const missingQuestion = fresh()
    delete missingQuestion.risk__beta
    expect(decide(input, missingQuestion).holds).toEqual(['malformed answer risk__beta'])

    const missingNoul = fresh()
    delete missingNoul.any_sound
    expect(decide(input, missingNoul).holds).toEqual(['malformed answer any_sound'])

    const badNoul = fresh()
    badNoul.any_sound = { noul: Number.NaN }
    expect(decide(input, badNoul).holds).toEqual(['malformed answer any_sound'])

    const badChoice = fresh()
    badChoice.first_step = { ...badChoice.first_step, choice: 'not_an_option' }
    expect(decide(input, badChoice).holds).toEqual(['malformed answer first_step'])

    const badKeys = fresh()
    badKeys.first_step = { ...badKeys.first_step, probabilities: { alpha: 0.9, beta: 0.1 } }
    expect(decide(input, badKeys).holds).toEqual(['malformed answer first_step'])

    const outOfRange = fresh()
    outOfRange.cost__alpha = { ...outOfRange.cost__alpha, score: 4 }
    expect(decide(input, outOfRange).holds).toEqual(['malformed answer cost__alpha'])

    expect(decide(input, null).recommendation).toBe('needs_lead')
    expect(decide(input, null).holds.every((hold) => hold.startsWith('malformed answer'))).toBe(true)
  })
})

describe('CLI', () => {
  const dirs: string[] = []
  const secret = 'typesafe-test-key-do-not-print'

  function writeInput(body: unknown = sample()) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-decide-'))
    dirs.push(dir)
    const file = join(dir, 'choice.json')
    writeFileSync(file, `${JSON.stringify(body)}\n`)
    return { dir, file }
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('parses flags and places the default result beside the input', () => {
    expect(parseArgs(['in.json', '--dry-run', '--model', 'jev-latest', '--out', 'out.json'])).toEqual({
      file: 'in.json',
      dryRun: true,
      rescore: false,
      model: 'jev-latest',
      out: 'out.json',
      force: false,
    })
    expect(parseArgs(['in.json', '--force']).force).toBe(true)
    expect(resultPath('/tmp/sets/choice.json', undefined)).toBe(join('/tmp/sets', 'choice.result.json'))
    expect(() => parseArgs(['--dry-run'])).toThrow(/usage:/)
    expect(() => parseArgs(['in.json', '--out'])).toThrow(/--out needs a value/)
    expect(() => parseArgs(['in.json', '--model'])).toThrow(/--model needs a value/)
    expect(() => parseArgs(['in.json', '--nope'])).toThrow(/usage:/)
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow(/usage:/)
  })

  it('dry-run prints the request and does not construct a client or write a file', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const { dir, file } = writeInput()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await main([file, '--dry-run'])
      const printed = log.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(printed).not.toContain(secret)
      const stderr = error.mock.calls.join('\n')
      expect(stderr).toMatch(/nothing sent/)
      expect(stderr).not.toContain(secret)
      const request = JSON.parse(printed) as { state: unknown; questions: Record<string, unknown> }
      const estimates = estimateTokens(request)
      expect(stderr).toContain(`about ${Math.round(estimates.requestTokens)} request tokens`)
      expect(stderr).toContain(`about ${Math.round(estimates.maxQuestionTokens)} question tokens`)
      expect(request.questions.first_step).toBeTruthy()
      expect(sdkMock.constructed).toEqual([])
      expect(sdkMock.systemOne).not.toHaveBeenCalled()
      expect(existsSync(join(dir, 'choice.result.json'))).toBe(false)
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  it('refuses a private field before any client exists', async () => {
    const { file } = writeInput({
      ...sample(),
      options: [option('alpha', { evidence: 'reach me at bob@example.com' }), option('beta')],
    })
    await expect(main([file, '--dry-run'])).rejects.toThrow('email address')
    expect(sdkMock.constructed).toEqual([])
    expect(sdkMock.systemOne).not.toHaveBeenCalled()
  })

  it('writes the decided result without printing the key', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const input = sample()
    const { dir, file } = writeInput(input)
    const answers = answersFor(input, {
      alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
      beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
    })
    sdkMock.systemOne.mockResolvedValue({ model: 'jev-1.13.0', answers, usage: { input_tokens: 3, output_tokens: 1 } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const out = join(dir, 'custom.result.json')
      await main([file, '--out', out, '--model', 'jev-latest'])
      expect(sdkMock.constructed).toEqual([{ defaultModel: 'jev-latest' }])
      expect(sdkMock.systemOne).toHaveBeenCalledTimes(1)
      const saved = readFileSync(out, 'utf8')
      expect(saved).not.toContain(secret)
      const report = log.mock.calls.join('\n')
      expect(report).not.toContain(secret)
      expect(report).toContain('Recommendation: alpha')
      expect(JSON.parse(saved)).toMatchObject({
        requestedModel: 'jev-latest',
        model: 'jev-1.13.0',
        weights: WEIGHTS,
        thresholds: THRESHOLDS,
        recommendation: 'alpha',
      })
    } finally {
      log.mockRestore()
    }
  })

  it('records a decide judgment and a receipt on the board with --task', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const input = sample()
    const { dir, file } = writeInput(input)
    const boardFile = join(dir, 'tasks.json')
    const claimed = { id: 3, role: 'qa-worker', title: 'Pick a fix', status: 'claimed', owner: 'qa-3', after: [] }
    writeFileSync(boardFile, JSON.stringify({ version: 1, tasks: [{ ...claimed, route: 'haiku_fork' }] }))
    const savedBoard = process.env.TEAM_TASKS_FILE
    process.env.TEAM_TASKS_FILE = boardFile
    const answers = answersFor(input, {
      alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
      beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
    })
    sdkMock.systemOne.mockResolvedValue({ model: 'jev-1.13.0', answers, usage: { input_tokens: 3, output_tokens: 1 } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main([file, '--task', '3', '--by', 'qa-3'])
      const [stored] = JSON.parse(readFileSync(boardFile, 'utf8')).tasks
      const entry = stored.decisions.at(-1)
      expect(entry).toMatchObject({
        kind: 'judgment',
        tool: 'decide',
        by: 'qa-3',
        outcome: 'answered',
        answer: 'alpha',
      })
      expect(existsSync(entry.receipt)).toBe(true)
      expect(readFileSync(entry.receipt, 'utf8')).not.toContain(secret)
    } finally {
      log.mockRestore()
      if (savedBoard === undefined) delete process.env.TEAM_TASKS_FILE
      else process.env.TEAM_TASKS_FILE = savedBoard
    }
  })

  it('refuses --task before calling Jev for a missing task or a gated task --by does not own', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const { dir, file } = writeInput(sample())
    const boardFile = join(dir, 'tasks.json')
    const gated = {
      id: 3,
      role: 'qa-worker',
      title: 'Pick a fix',
      status: 'claimed',
      owner: 'qa-3',
      after: [],
      accept: 'the fix is picked',
    }
    writeFileSync(boardFile, JSON.stringify({ version: 1, tasks: [{ ...gated, route: 'haiku_fork' }] }))
    const savedBoard = process.env.TEAM_TASKS_FILE
    process.env.TEAM_TASKS_FILE = boardFile
    try {
      await expect(main([file, '--task', '3', '--by', 'qa-9'])).rejects.toThrow('--by must be the owner')
      await expect(main([file, '--task', '9', '--by', 'qa-3'])).rejects.toThrow('does not exist')
      expect(sdkMock.systemOne).not.toHaveBeenCalled()
    } finally {
      if (savedBoard === undefined) delete process.env.TEAM_TASKS_FILE
      else process.env.TEAM_TASKS_FILE = savedBoard
    }
  })

  it('does not call the API when the key is missing', async () => {
    delete process.env.TYPESAFE_API_KEY
    const { file } = writeInput()
    await expect(main([file])).rejects.toThrow('TYPESAFE_API_KEY is not set')
    expect(sdkMock.constructed).toEqual([])
    expect(sdkMock.systemOne).not.toHaveBeenCalled()
  })

  it('refuses an email on a live run before any client exists', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const { dir, file } = writeInput({
      ...sample(),
      options: [option('alpha', { evidence: 'reach me at bob@example.com' }), option('beta')],
    })
    await expect(main([file])).rejects.toThrow('email address')
    expect(sdkMock.constructed).toEqual([])
    expect(sdkMock.systemOne).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'choice.result.json'))).toBe(false)
  })

  it('sends buildRequest output and warns about dropped fields', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const raw = {
      ...sample(),
      extras: [1, 2, 3],
      options: [{ ...option('alpha'), extra: 'hidden' }, option('beta')],
    }
    const { file } = writeInput(raw)
    const input = parseInput(raw).input
    const answers = answersFor(input, {
      alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
      beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
    })
    sdkMock.systemOne.mockResolvedValue({ model: 'jev-1.13.0', answers, usage: {} })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main([file])
      expect(sdkMock.systemOne.mock.calls[0]?.[0]).toEqual(buildRequest(input))
      expect(JSON.stringify(sdkMock.systemOne.mock.calls[0]?.[0])).not.toContain('extras')
      expect(JSON.stringify(sdkMock.systemOne.mock.calls[0]?.[0])).not.toContain('hidden')
      expect(warn.mock.calls.join('\n')).toContain('dropped input.extras (not sent)')
      expect(existsSync(join(file, '..', 'choice.result.json')) || existsSync(resultPath(file, undefined))).toBe(true)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('writes the default result beside the input', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const input = sample()
    const { dir, file } = writeInput(input)
    sdkMock.systemOne.mockResolvedValue({
      model: 'jev-1.13.0',
      answers: answersFor(input, {
        alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
        beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
      }),
      usage: {},
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main([file])
      expect(existsSync(join(dir, 'choice.result.json'))).toBe(true)
      expect(log.mock.calls.join('\n')).toContain('Recommendation: alpha')
    } finally {
      log.mockRestore()
    }
  })

  it('records the rubric and rescores a saved result with no API call', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const input = sample()
    const { dir, file } = writeInput(input)
    sdkMock.systemOne.mockResolvedValue({
      model: 'jev-1.13.0',
      answers: answersFor(input, {
        alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0, confidence: 0.3 }, value: { score: 3 } },
        beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
      }),
      usage: {},
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main([file])
      const saved = JSON.parse(readFileSync(join(dir, 'choice.result.json'), 'utf8'))
      expect(saved.rubric).toBe('general')
      expect(inputFromResult(saved)).toEqual(input)
      sdkMock.systemOne.mockClear()
      log.mockClear()
      await main(['--rescore', join(dir, 'choice.result.json'), '--out', join(dir, 'rescored.json')])
      expect(sdkMock.systemOne).not.toHaveBeenCalled()
      expect(log.mock.calls.join('\n')).toContain('Recommendation: alpha')
      const rescored = JSON.parse(readFileSync(join(dir, 'rescored.json'), 'utf8'))
      expect(rescored).toMatchObject({ recommendation: 'alpha', holds: [], rubric: 'general' })
    } finally {
      log.mockRestore()
    }
  })

  it('rescores a result saved without a rubric', () => {
    const input = sample()
    const request = buildRequest(input)
    const legacy = { request, rawAnswers: answersFor(input, {}) }
    expect(inputFromResult(legacy)).toEqual({ ...input, rubric: 'general' })
    expect(() => inputFromResult({ request })).toThrow(/no request or raw answers/)
    expect(() => inputFromResult({ ...legacy, rubric: 'nope' })).toThrow(/unknown rubric/)
    expect(() => parseArgs(['--rescore', '--dry-run', 'r.json'])).toThrow(/cannot be used together/)
  })

  it('redacts the API key from failure text', () => {
    process.env.TYPESAFE_API_KEY = `  ${secret}  `
    const text = formatFailure(new Error(`before ${secret} after`))
    expect(text).toBe('jev-decide failed: Error: before [redacted] after')
    expect(text).not.toContain(secret)
    process.env.TYPESAFE_API_KEY = '   '
    expect(formatFailure(new Error('plain failure'))).toBe('jev-decide failed: Error: plain failure')
  })

  it('refuses an input that contains the API key before printing or calling', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const { dir, file } = writeInput({ ...sample(), decision: `Choose ${secret} now` })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(main([file, '--dry-run'])).rejects.toThrow('input contains the API key; remove it')
      await expect(main([file])).rejects.toThrow('input contains the API key; remove it')
      expect(log.mock.calls.join('\n')).not.toContain(secret)
      expect(sdkMock.constructed).toEqual([])
      expect(sdkMock.systemOne).not.toHaveBeenCalled()
      expect(existsSync(join(dir, 'choice.result.json'))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  it('does not treat a blank API key as present in the input', async () => {
    process.env.TYPESAFE_API_KEY = '   '
    const { file } = writeInput()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await main([file, '--dry-run'])
      expect(sdkMock.constructed).toEqual([])
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  it('refuses an oversized request before any client exists', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const text = 'word '.repeat(800).trim()
    const { dir, file } = writeInput({
      decision: 'Choose a first step',
      context: text,
      options: Array.from({ length: 12 }, (_, i) =>
        option(`opt${i}`, { title: text, description: text, evidence: text }),
      ),
    })
    await expect(main([file])).rejects.toThrow(/shorten the evidence or split the options/)
    expect(sdkMock.constructed).toEqual([])
    expect(sdkMock.systemOne).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'choice.result.json'))).toBe(false)
  })

  it('checks --out before any client exists', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const { dir, file } = writeInput()
    await expect(main([file, '--out', file, '--force'])).rejects.toThrow('refusing to overwrite the input')
    const existing = join(dir, 'custom.result.json')
    writeFileSync(existing, 'keep\n')
    await expect(main([file, '--out', existing])).rejects.toThrow(/pass --force to overwrite/)
    expect(readFileSync(existing, 'utf8')).toBe('keep\n')
    await expect(main([file, '--out', dir])).rejects.toThrow('is a directory')
    await expect(main([file, '--out', join(dir, 'missing', 'out.json')])).rejects.toThrow(
      'output directory does not exist',
    )
    expect(sdkMock.constructed).toEqual([])
    expect(sdkMock.systemOne).not.toHaveBeenCalled()
  })

  it('overwrites an existing result when --force is set', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const input = sample()
    const { dir, file } = writeInput(input)
    const out = join(dir, 'custom.result.json')
    writeFileSync(out, 'old\n')
    sdkMock.systemOne.mockResolvedValue({
      model: 'jev-1.13.0',
      answers: answersFor(input, {
        alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
        beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
      }),
      usage: {},
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main([file, '--out', out, '--force'])
      expect(JSON.parse(readFileSync(out, 'utf8')).recommendation).toBe('alpha')
    } finally {
      log.mockRestore()
    }
  })

  it('saves the paid response when decide throws', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const input = sample()
    const { file } = writeInput(input)
    const answers = answersFor(input, {
      alpha: { evidence: { score: 3 }, risk: { score: 0 }, cost: { score: 0 }, value: { score: 3 } },
      beta: { evidence: { score: 0 }, risk: { score: 3 }, cost: { score: 3 }, value: { score: 0 } },
    })
    sdkMock.systemOne.mockResolvedValue({ model: 'jev-1.13.0', answers, usage: {} })
    const out = resultPath(file, undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(
        main([file], {
          decide: () => {
            throw new Error(`paid ${secret} lost`)
          },
        }),
      ).rejects.toThrow(secret)
      const saved = JSON.parse(readFileSync(out, 'utf8')) as { rawAnswers: unknown; request: unknown; error: string }
      expect(saved.rawAnswers).toEqual(answers)
      expect(saved.request).toEqual(buildRequest(input))
      expect(saved.error).toContain('[redacted]')
      expect(saved.error).not.toContain(secret)
      expect(JSON.stringify(saved)).not.toContain(secret)
    } finally {
      log.mockRestore()
    }
  })

  it('saves a malformed paid answer as needs_lead', async () => {
    process.env.TYPESAFE_API_KEY = secret
    const { file } = writeInput()
    const out = resultPath(file, undefined)
    sdkMock.systemOne.mockResolvedValue({ model: 'jev-1.13.0', answers: {}, usage: {} })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main([file])
      const saved = JSON.parse(readFileSync(out, 'utf8')) as {
        recommendation: string
        holds: string[]
        rawAnswers: unknown
      }
      expect(saved.recommendation).toBe('needs_lead')
      expect(saved.holds[0]).toBe('malformed answer evidence__alpha')
      expect(saved.rawAnswers).toEqual({})
      expect(saved).not.toHaveProperty('error')
    } finally {
      log.mockRestore()
    }
  })
})
