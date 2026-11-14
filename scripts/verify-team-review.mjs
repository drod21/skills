// Bounded exhaustive exploration of the real review commands; no board file or provider calls.
import assert from 'node:assert/strict'
import { parseReview } from './team-review.mjs'
import { addTask, claimTask, addEvidence, recordReview, addJudgment, doneTask } from './team-tasks.lib.mjs'

const MAX_DEPTH = 5
const FIXED_TIME = new Date(0)
const OWNER = 'reviewer'
const finding = (frequency, impact, conditions, status) => ({
  id: 'finding',
  comment: 'Observable review issue',
  conditions,
  frequency,
  impact,
  rationale: 'Bounded verification input',
  crossCheck: { status: 'unavailable', evidence: 'No provider calls in this check' },
  disposition:
    status === 'fixed'
      ? { status, evidence: 'Focused acceptance receipt' }
      : status === 'deferred'
        ? { status, reason: 'Below the agreed threshold' }
        : status === 'blocked'
          ? { status, reason: 'Acceptance unavailable', owner: 'lead' }
          : { status },
})

// Independent oracle: do not call needsFix, reviewBlockers, or doneBlockers here.
const qualifies = (frequency, impact) => frequency > 0 && (impact >= 8 || frequency * impact >= 20)
const allowedDisposition = (frequency, impact, status) =>
  qualifies(frequency, impact) ? status !== 'deferred' : status === 'deferred' || status === 'pending'

let matrixCases = 0
for (let frequency = 0; frequency <= 10; frequency++) {
  for (let impact = 1; impact <= 10; impact++) {
    for (const conditions of [null, 'When the affected flow runs']) {
      for (const status of ['pending', 'fixed', 'deferred', 'blocked']) {
        const expectedFrequency = conditions === null ? 0 : frequency
        let parsed
        try {
          parsed = parseReview({ findings: [finding(frequency, impact, conditions, status)] })
        } catch (error) {
          assert.equal(allowedDisposition(expectedFrequency, impact, status), false, error.message)
        }
        if (parsed) {
          assert.equal(allowedDisposition(expectedFrequency, impact, status), true)
          assert.equal(parsed.findings[0].frequency, expectedFrequency)
        }
        matrixCases++
      }
    }
  }
}

const actions = [
  'clean',
  'pending',
  'fixed',
  'deferred',
  'blocked',
  'stranger',
  'change-score',
  'prepare',
  'finish',
  'confirm',
  'done',
  'force',
]
const resolved = (status) => ['clean', 'fixed', 'deferred'].includes(status)
const summary = { matrixCases, maxDepth: MAX_DEPTH, states: 0, transitions: 0, completions: 0, witnesses: {} }

function initial() {
  const board = { tasks: [] }
  const task = addTask(board, { role: 'qa-worker', title: 'Review', review: true, accept: 'Current review resolved' })
  claimTask(board, 'qa-worker', OWNER, { id: task.id, now: FIXED_TIME })
  addEvidence(board, task.id, ['review.log'])
  return { board, ghost: { review: 'missing', epoch: 0, confirmed: -1 }, pending: null, trace: [] }
}

function checkPayload(basis) {
  return JSON.stringify({
    tool: 'check',
    outcome: 'confirmed',
    by: OWNER,
    question: 'Is the current review resolved?',
    answer: null,
    p: 1,
    confidence: 1,
    reasons: [],
    requestHash: 'a'.repeat(64),
    receipt: 'acceptance.json',
    evidence: ['review.log'],
    basis,
  })
}

function expectedReviewAcceptance(action, hasFinding, frequency, impact) {
  if (action === 'stranger') return false
  if (action === 'clean') return !hasFinding
  if (action === 'change-score') return false
  return allowedDisposition(frequency, impact, action)
}

function reviewOperation(next, action, sample) {
  const task = next.board.tasks[0]
  const hasFinding = !['missing', 'clean'].includes(next.ghost.review)
  if (action === 'change-score' && (!hasFinding || sample.conditions === null)) return null
  const normalizedFrequency = sample.conditions === null ? 0 : sample.frequency
  const frequency = action === 'change-score' ? (sample.frequency + 1) % 11 : sample.frequency
  const status = ['stranger', 'change-score'].includes(action) ? 'pending' : action
  return {
    kind: 'review',
    normalizedFrequency,
    expected: expectedReviewAcceptance(action, hasFinding, normalizedFrequency, sample.impact),
    run: () =>
      recordReview(
        next.board,
        task.id,
        parseReview({
          findings: action === 'clean' ? [] : [finding(frequency, sample.impact, sample.conditions, status)],
        }),
        action === 'stranger' ? 'stranger' : OWNER,
      ),
  }
}

function checkOperation(next, action) {
  const task = next.board.tasks[0]
  if (action === 'finish' && !next.pending) return null
  const basis = action === 'finish' ? next.pending.basis : (task.decisions?.length ?? 0)
  return {
    kind: 'check',
    expected: action !== 'finish' || next.pending.epoch === next.ghost.epoch,
    run: () => addJudgment(next.board, task.id, checkPayload(basis), { now: FIXED_TIME }),
  }
}

function operationFor(next, action, sample) {
  if (action === 'confirm' || action === 'finish') return checkOperation(next, action)
  if (action === 'done' || action === 'force') {
    return {
      kind: 'done',
      expected: resolved(next.ghost.review) && next.ghost.confirmed === next.ghost.epoch,
      run: () =>
        doneTask(
          next.board,
          next.board.tasks[0].id,
          action === 'force' ? { force: true, now: FIXED_TIME } : { owner: OWNER, now: FIXED_TIME },
        ),
    }
  }
  return reviewOperation(next, action, sample)
}

function runOperation(next, operation) {
  const before = JSON.stringify(next.board)
  let accepted = false
  let result
  try {
    result = operation.run()
    accepted = true
  } catch (error) {
    if (operation.expected) throw new Error(`Unexpected refusal: ${next.trace.join(' -> ')}: ${error.message}`)
  }
  assert.equal(accepted, operation.expected, `Wrong command outcome: ${next.trace.join(' -> ')}`)
  if (!accepted) {
    assert.equal(JSON.stringify(next.board), before, `Refused command mutated the board: ${next.trace.join(' -> ')}`)
  }
  return { accepted, result }
}

function retainRefusalWitness(next, action) {
  if (action === 'finish') summary.witnesses.staleCheckRejected ??= next.trace
  if (action !== 'done' && action !== 'force') return
  if (!resolved(next.ghost.review)) summary.witnesses.unresolvedCompletionRejected ??= next.trace
  else if (next.ghost.confirmed >= 0) summary.witnesses.staleConfirmationRejected ??= next.trace
}

function advanceAccepted(next, action, operation, result) {
  const { ghost } = next
  if (operation.kind === 'done') {
    assert.equal(result.status, 'done')
    assert.equal(result.completionReport.unfixed.length, ghost.review === 'deferred' ? 1 : 0)
    summary.completions++
    summary.witnesses.resolvedCompletion ??= next.trace
  } else if (operation.kind === 'check') {
    ghost.confirmed = ghost.epoch
  } else {
    ghost.review = action
    ghost.epoch++
    if (action !== 'clean')
      assert.equal(next.board.tasks[0].review.findings[0].frequency, operation.normalizedFrequency)
  }
}

function transition(state, action, sample) {
  const next = structuredClone(state)
  next.trace.push(action)
  if (action === 'prepare') {
    if (next.pending) return null
    next.pending = { epoch: next.ghost.epoch, basis: next.board.tasks[0].decisions?.length ?? 0 }
    return next
  }
  const operation = operationFor(next, action, sample)
  if (!operation) return null
  const { accepted, result } = runOperation(next, operation)
  if (accepted) advanceAccepted(next, action, operation, result)
  else retainRefusalWitness(next, action)
  if (action === 'finish') next.pending = null
  return next
}
// Retain the full semantic journal, including check bases, but discard timestamps.
function key(state) {
  return JSON.stringify({
    ghost: state.ghost,
    pending: state.pending,
    status: state.board.tasks[0].status,
    review: state.board.tasks[0].review,
    decisions: state.board.tasks[0].decisions?.map(({ at: _at, ...entry }) => entry),
  })
}

for (const sample of [
  { frequency: 1, impact: 7, conditions: 'When the flow runs' },
  { frequency: 1, impact: 8, conditions: 'When the flow runs' },
  { frequency: 2, impact: 10, conditions: 'When the flow runs' },
  { frequency: 10, impact: 10, conditions: null },
]) {
  const start = initial()
  const queue = [start]
  const seen = new Set([key(start)])
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index]
    summary.states++
    if (state.trace.length >= MAX_DEPTH || state.board.tasks[0].status === 'done') continue
    for (const action of actions) {
      const next = transition(state, action, sample)
      if (!next) continue
      summary.transitions++
      const encoded = key(next)
      if (seen.has(encoded)) continue
      seen.add(encoded)
      queue.push(next)
    }
  }
}
for (const witness of [
  'staleCheckRejected',
  'unresolvedCompletionRejected',
  'staleConfirmationRejected',
  'resolvedCompletion',
]) {
  assert.ok(summary.witnesses[witness], `Missing non-vacuity witness: ${witness}`)
}
console.log(JSON.stringify({ status: 'PASS', ...summary }, null, 2))
