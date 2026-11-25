import * as z from 'zod'
import { needsFix } from './team-tasks.lib.mjs'

const text = z.string().min(1).max(4000).refine((value) => !!value.trim())
const disposition = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('fixed'), evidence: text }),
  z.object({ status: z.literal('deferred'), reason: text }),
  z.object({ status: z.literal('blocked'), reason: text, owner: text }),
])
const crossCheck = z.discriminatedUnion('status', [
  z.object({ status: z.literal('checked'), receipt: text }),
  z.object({ status: z.literal('unavailable'), evidence: text }),
])
export const reviewSchema = z.object({
  findings: z.array(
    z.object({
      id: text,
      comment: text,
      conditions: text.nullable(),
      frequency: z.number().int().min(0).max(10),
      impact: z.number().int().min(1).max(10),
      rationale: text,
      crossCheck,
      disposition,
    }),
  ),
})

/** @typedef {z.infer<typeof reviewSchema>} ReviewBody */

export function parseReview(value) {
  const review = reviewSchema.parse(value)
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
