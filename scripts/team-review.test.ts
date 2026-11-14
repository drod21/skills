import { describe, expect, it } from 'vitest'

import { parseReview } from './team-review.mjs'
import {
  addTask,
  claimTask,
  doneTask,
  doneBlockers,
  recordReview,
  reviewReport,
  addEvidence,
  addJudgment,
} from './team-tasks.lib.mjs'
import { hashRequest, toJudgment } from './jev-ask.lib.ts'

function finding(frequency: number, impact: number, status = 'pending') {
  return {
    id: 'r1',
    comment: 'An issue',
    conditions: 'When opening the screen',
    frequency,
    impact,
    rationale: 'Observed in the affected flow',
    crossCheck: { status: 'unavailable', evidence: 'retained API failure log' },
    disposition:
      status === 'fixed'
        ? { status, evidence: 'test passed' }
        : status === 'deferred'
          ? { status, reason: 'Below threshold' }
          : { status },
  }
}

describe('scored reviews', () => {
  it('enforces all frequency/impact boundaries and normalizes unknown conditions', () => {
    for (let f = 0; f <= 10; f++)
      for (let i = 1; i <= 10; i++) {
        const qualifies = f * i >= 20 || (f >= 1 && i >= 8)
        const status = qualifies ? 'fixed' : 'deferred'
        expect(parseReview({ findings: [finding(f, i, status)] }).findings[0].disposition.status).toBe(status)
        expect(() => parseReview({ findings: [finding(f, i, qualifies ? 'deferred' : 'fixed')] })).toThrow(/threshold/)
      }
    expect(
      parseReview({ findings: [{ ...finding(10, 10, 'deferred'), conditions: null }] }).findings[0].frequency,
    ).toBe(0)
    expect(() => parseReview({ findings: [{ ...finding(1, 8), frequency: 1.5 }] })).toThrow()
  })

  it('holds review tasks until dispositioned and reports every unfixed finding', () => {
    const board = { tasks: [] }
    const task = addTask(board, { role: 'lead', title: 'Review', review: true })
    claimTask(board, 'lead', 'reviewer', { id: task.id })
    expect(() => doneTask(board, task.id, { owner: 'reviewer' })).toThrow(/WithoutReview/)
    recordReview(board, task.id, { findings: [finding(1, 7)] }, 'reviewer')
    expect(doneBlockers(task).join(' ')).toContain('UnresolvedReview')
    expect(() => recordReview(board, task.id, { findings: [] }, 'reviewer')).toThrow(/retain/)
    expect(() => recordReview(board, task.id, { findings: [finding(0, 1, 'deferred')] }, 'reviewer')).toThrow(
      /preserve/,
    )
    recordReview(board, task.id, { findings: [finding(1, 7, 'deferred')] }, 'reviewer')
    doneTask(board, task.id, { owner: 'reviewer' })
    expect(task.completionReport.unfixed).toHaveLength(1)
    expect(reviewReport(task).unfixed[0]).toMatchObject({ frequency: 1, impact: 7, product: 7, qualifies: false })
  })

  it('requires owner submission and allows an explicit clean review', () => {
    const board = { tasks: [] }
    const task = addTask(board, { role: 'lead', title: 'Review', review: true })
    claimTask(board, 'lead', 'reviewer', { id: task.id })
    expect(() => recordReview(board, task.id, { findings: [] }, 'stranger')).toThrow(/owner/)
    recordReview(board, task.id, { findings: [] }, 'reviewer')
    doneTask(board, task.id, { owner: 'reviewer' })
    expect(task.completionReport.unfixed).toEqual([])
  })

  it('voids a previous confirmation, including a check in flight, and cannot be forced past pending review', () => {
    const board = { tasks: [] }
    const task = addTask(board, { role: 'qa-worker', title: 'Review', review: true, accept: 'Findings resolved' })
    claimTask(board, 'qa-worker', 'reviewer', { id: task.id })
    addEvidence(board, task.id, ['evidence.log'])
    const check = (basis: number) =>
      JSON.stringify(
        toJudgment(
          'check',
          {
            outcome: 'confirmed',
            gap: 'fits',
            p: 0.95,
            reasons: [],
          },
          {
            by: 'reviewer',
            question: 'Resolved?',
            requestHash: hashRequest('review-test'),
            receipt: 'receipt.json',
            evidence: task.evidence,
            basis,
          },
        ),
      )
    const basis = task.decisions?.length ?? 0
    addJudgment(board, task.id, check(basis))
    recordReview(board, task.id, parseReview({ findings: [finding(2, 10)] }), 'reviewer')
    expect(() => addJudgment(board, task.id, check(basis))).toThrow(/run the check again/)
    expect(() => doneTask(board, task.id, { force: true })).toThrow(/UnresolvedReview/)
    recordReview(board, task.id, parseReview({ findings: [finding(2, 10, 'fixed')] }), 'reviewer')
    expect(() => doneTask(board, task.id, { force: true })).toThrow(/Unconfirmed/)
    addJudgment(board, task.id, check(task.decisions.length))
    doneTask(board, task.id, { owner: 'reviewer' })
    expect(task.completionReport.unfixed).toEqual([])
  })
})
