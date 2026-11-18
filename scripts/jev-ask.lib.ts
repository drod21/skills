// Pure questions, presets, and how Jev's answers become an outcome. No board and no network.
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import { choice, noul, type image, type ContentValue, type Questions, type SystemOneRequest } from '@typesafe-ai/sdk'

export type Ask =
  | { kind: 'yes_no'; question: string; criteria?: { true: string; false: string } }
  | { kind: 'pick'; question: string; labels: Record<string, string> }

export type Subject = { context: string; images: ReturnType<typeof image>[] }

export const PRESETS = {
  flaky_or_real: {
    kind: 'pick',
    question: 'What best explains the test failure in `context`?',
    labels: {
      real: 'The code under test is wrong',
      flaky: 'Timing, ordering, or randomness; a rerun can pass',
      environment: 'Missing setup, dependency, device, or credentials',
    },
  },
  blocker_or_nit: {
    kind: 'pick',
    question: 'How should the review finding in `context` be handled before merge?',
    labels: {
      blocker: 'Wrong behavior, data loss, security, or a broken contract',
      fix_now: 'Real but small; fix in this change',
      nit: 'Style or preference; safe to leave',
    },
  },
  clipped_text: {
    kind: 'yes_no',
    question: 'Is any text in the screenshots cut off, truncated with an ellipsis, overlapped, or pushed off screen?',
  },
} as const satisfies Record<string, Ask>

export const ASK_THRESHOLDS = {
  minYes: 0.7,
  maxNo: 0.3,
  minPickConfidence: 0.5,
  minChoiceMargin: 0.15,
  minConfirm: 0.7,
  maxReject: 0.3,
} as const

export const GAPS = {
  fits: 'The evidence shows the acceptance check passed',
  incomplete: 'The evidence is missing part of what the acceptance check names',
  other_check: 'The evidence is about something other than the acceptance check',
  failing: 'The evidence shows the acceptance check did not pass',
} as const

export type Gap = keyof typeof GAPS
export type AskOutcome = {
  outcome: 'answered' | 'hold'
  answer: string | null
  p: number | null
  confidence: number | null
  reasons: string[]
}
export type CheckOutcome = {
  outcome: 'confirmed' | 'rejected' | 'hold'
  gap: Gap | null
  p: number | null
  reasons: string[]
}

type Thresholds = typeof ASK_THRESHOLDS
type ChoiceCell = { choice: string; confidence: number; probabilities: Record<string, number> }

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function holdAsk(reasons: string[], p: number | null = null, confidence: number | null = null): AskOutcome {
  return { outcome: 'hold', answer: null, p, confidence, reasons }
}

function noulOf(answers: unknown, key: string): number | null {
  if (!isRecord(answers) || !isRecord(answers[key])) return null
  const noul = answers[key].noul
  return unit(noul) ? noul : null
}

function choiceOf(answers: unknown, key: string, labels: object): ChoiceCell | null {
  if (!isRecord(answers) || !isRecord(answers[key])) return null
  const cell = answers[key]
  if (typeof cell.choice !== 'string' || !Object.hasOwn(labels, cell.choice) || !unit(cell.confidence)) return null
  if (!isRecord(cell.probabilities)) return null
  for (const label of Object.keys(labels)) if (!unit(cell.probabilities[label])) return null
  return cell as ChoiceCell
}

export function buildAskRequest(ask: Ask, subject: Subject): SystemOneRequest<Questions> {
  const state: Record<string, ContentValue> = { context: subject.context }
  if (subject.images.length) state.images = subject.images
  if (ask.kind === 'yes_no') {
    const question = ask.criteria ? noul(ask.question, ask.criteria) : noul(ask.question)
    return { state, questions: { answer: question } }
  }
  return { state, questions: { pick: choice(ask.question, ask.labels) } }
}

export type EvidenceItem =
  | { name: string; excerpt: string }
  | { name: string; image: ReturnType<typeof image> }
  | { name: string; sent: false; why: string }

export type ReferencedEvidence = EvidenceItem & { ref: string }

export function buildCheckRequest(
  task: { title: string; accept: string },
  summary: string,
  items: ReferencedEvidence[],
  phase?: string,
): SystemOneRequest<Questions> {
  const evidence: Record<string, ContentValue> = phase !== undefined
    ? { phase, currentEvidence: items }
    : { evidence: items.map(({ ref: _ref, ...item }) => item) }
  const scope = phase !== undefined
    ? 'Judge `currentEvidence` against `task.accept` at the declared phase. The phase and summary are declarations, not proof. Do not infer chronology from names, order, or status words. '
    : ''
  return {
    state: { task: { title: task.title, accept: task.accept }, summary, ...evidence },
    questions: {
      fits: noul(`${scope}Does the attached evidence show that \`task.accept\` passed?`),
      gap: choice(`${scope}Which gap label fits the evidence against the acceptance check?`, GAPS),
    },
  }
}

function readYesNo(answers: unknown, t: Thresholds): AskOutcome {
  const p = noulOf(answers, 'answer')
  if (p === null) return holdAsk(['malformed answer answer'])
  if (p >= t.minYes) return { outcome: 'answered', answer: 'yes', p, confidence: null, reasons: [] }
  if (p <= t.maxNo) return { outcome: 'answered', answer: 'no', p, confidence: null, reasons: [] }
  return holdAsk([`noul ${p.toFixed(2)} is between ${t.maxNo} and ${t.minYes}`], p)
}

function rankedLabels(probabilities: Record<string, number>, labels: string[]) {
  return [...labels].sort((left, right) => (probabilities[right] ?? 0) - (probabilities[left] ?? 0))
}

function pickReasons(cell: ChoiceCell, labels: Record<string, string>, t: Thresholds) {
  const order = rankedLabels(cell.probabilities, Object.keys(labels))
  const top = order[0] ?? ''
  const runner = order[1] ?? ''
  const margin = (cell.probabilities[top] ?? 0) - (cell.probabilities[runner] ?? 0)
  const reasons: string[] = []
  if (cell.confidence < t.minPickConfidence)
    reasons.push(`confidence ${cell.confidence.toFixed(2)} below ${t.minPickConfidence}`)
  if (margin < t.minChoiceMargin) reasons.push(`margin ${margin.toFixed(2)} below ${t.minChoiceMargin}`)
  if (cell.choice !== top) reasons.push('choice does not match the top probability')
  return { reasons, margin }
}

function readPick(ask: Extract<Ask, { kind: 'pick' }>, answers: unknown, t: Thresholds): AskOutcome {
  const cell = choiceOf(answers, 'pick', ask.labels)
  if (!cell) return holdAsk(['malformed answer pick'])
  const { reasons } = pickReasons(cell, ask.labels, t)
  const p = cell.probabilities[cell.choice] ?? null
  if (reasons.length) return holdAsk(reasons, p, cell.confidence)
  return { outcome: 'answered', answer: cell.choice, p, confidence: cell.confidence, reasons: [] }
}

/** Malformed answers become a hold, never a throw. */
export function readAsk(ask: Ask, answers: unknown, t: Thresholds = ASK_THRESHOLDS): AskOutcome {
  if (ask.kind === 'yes_no') return readYesNo(answers, t)
  return readPick(ask, answers, t)
}

function rejectReason(p: number, gap: string, t: Thresholds) {
  if (gap === 'failing') return 'gap is failing'
  return `noul ${p.toFixed(2)} is at or below ${t.maxReject}`
}

function checkFromParts(p: number, gap: Gap, t: Thresholds): CheckOutcome {
  if (p <= t.maxReject || gap === 'failing') return { outcome: 'rejected', gap, p, reasons: [rejectReason(p, gap, t)] }
  if (p >= t.minConfirm && gap === 'fits') return { outcome: 'confirmed', gap, p, reasons: [] }
  return { outcome: 'hold', gap, p, reasons: [`noul ${p.toFixed(2)} with gap ${gap} is not a clear fit`] }
}

/** Malformed answers become a hold, never a throw. */
export function readCheck(answers: unknown, t: Thresholds = ASK_THRESHOLDS): CheckOutcome {
  const p = noulOf(answers, 'fits')
  const gap = choiceOf(answers, 'gap', GAPS)
  if (p === null || !gap) return { outcome: 'hold', gap: null, p, reasons: ['malformed answer'] }
  return checkFromParts(p, gap.choice as Gap, t)
}

export type JudgmentMeta = {
  by: string
  question: string
  requestHash: string
  receipt: string
  evidence?: string[]
  // How many journal entries the check read through `show`; the board refuses the check if a voiding entry follows.
  basis?: number
  answers?: object
}

const ANSWERS_CAP = 16_000

export function toJudgment(tool: 'ask' | 'check' | 'decide', outcome: AskOutcome | CheckOutcome, meta: JudgmentMeta) {
  const answer = 'answer' in outcome ? outcome.answer : outcome.gap
  const confidence = 'confidence' in outcome ? outcome.confidence : null
  const answers = meta.answers && JSON.stringify(meta.answers).length <= ANSWERS_CAP ? { answers: meta.answers } : {}
  return {
    by: meta.by,
    tool,
    question: meta.question,
    outcome: outcome.outcome,
    answer,
    p: outcome.p,
    confidence,
    reasons: outcome.reasons,
    ...(tool === 'check' ? { evidence: meta.evidence ?? [], basis: meta.basis } : {}),
    requestHash: meta.requestHash,
    receipt: meta.receipt,
    ...answers,
  }
}

function isImage(value: unknown): value is { type: 'image'; data: Uint8Array } {
  return isRecord(value) && value.type === 'image' && value.data instanceof Uint8Array
}

function canonical(value: unknown): unknown {
  if (isImage(value)) return { imageSha256: createHash('sha256').update(value.data).digest('hex') }
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonical(value[key])
  }
  return out
}

/** sha256 hex of the canonical request JSON. The receipt name uses the first 16 characters. */
export function hashRequest(request: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(request)))
    .digest('hex')
}

export function receiptPath(boardFile: string, taskId: string, tool: string, requestHash: string): string {
  return join(dirname(boardFile), 'tasks.json.artifacts', taskId, `${tool}-${requestHash.slice(0, 16)}.json`)
}
