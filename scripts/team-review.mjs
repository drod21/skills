import { type } from 'arktype'
import { needsFix } from './team-tasks.lib.mjs'

const text = type('0 < string <= 4000').narrow((value) => !!value.trim())
const disposition = type({ status: "'pending'" })
  .or({ status: "'fixed'", evidence: text })
  .or({ status: "'deferred'", reason: text })
  .or({ status: "'blocked'", reason: text, owner: text })
const crossCheck = type({ status: "'checked'", receipt: text }).or({ status: "'unavailable'", evidence: text })
export const reviewSchema = type({
  findings: type({
    id: text,
    comment: text,
    conditions: text.or('null'),
    frequency: '0 <= number.integer <= 10',
    impact: '1 <= number.integer <= 10',
    rationale: text,
    crossCheck,
    disposition,
  }).array(),
})

export function parseReview(value) {
  const review = reviewSchema.assert(value)
  const seen = new Set()
  for (const finding of review.findings) {
    if (seen.has(finding.id)) throw new Error(`duplicate finding ${finding.id}`)
    seen.add(finding.id)
    if (finding.conditions === null) finding.frequency = 0
    const qualifies = needsFix(finding)
    if (!qualifies && finding.disposition.status !== 'deferred' && finding.disposition.status !== 'pending')
      throw new Error(`finding ${finding.id} is below the fix threshold; leave it deferred`)
    if (qualifies && finding.disposition.status === 'deferred')
      throw new Error(`finding ${finding.id} meets the fix threshold; fix it or record its blocker`)
  }
  return review
}
