import { describe, expect, it } from 'vitest'
import { ageLabel, hoursSince, ownerLabel, sinceLabel } from './format'

const now = Date.parse('2026-11-10T12:00:00.000Z')
const ago = (ms: number) => new Date(now - ms).toISOString()

describe('ageLabel', () => {
  it('uses the fewest characters that stay exact enough', () => {
    expect(ageLabel(ago(10_000), now)).toBe('now')
    expect(ageLabel(ago(5 * 60_000), now)).toBe('5m')
    expect(ageLabel(ago(3 * 3_600_000), now)).toBe('3h')
    expect(ageLabel(ago(2 * 86_400_000), now)).toBe('2d')
    expect(ageLabel(ago(21 * 86_400_000), now)).toBe('3w')
  })

  it('has no age for a missing or unreadable time', () => {
    expect(ageLabel(null, now)).toBeNull()
    expect(ageLabel('soon', now)).toBeNull()
  })

  it('never reports a time in the future as a negative age', () => {
    expect(ageLabel(ago(-60_000), now)).toBe('now')
  })
})

describe('hoursSince', () => {
  it('counts whole hours', () => {
    expect(hoursSince(ago(150 * 60_000), now)).toBe(2)
    expect(hoursSince(null, now)).toBeNull()
  })
})

describe('ownerLabel', () => {
  it('keeps a plain name', () => {
    expect(ownerLabel('worker-ux')).toBe('worker-ux')
  })

  it('shortens a path to its last part', () => {
    expect(ownerLabel('/root/study_v3_runtime_qa')).toBe('study_v3_runtime_qa')
  })

  it('reads a delegated task id out of its encoded prefix', () => {
    expect(ownerLabel('node%3Adelegated-task%3Aabc123')).toBe('abc123')
  })

  it('keeps text that is not valid percent-encoding', () => {
    expect(ownerLabel('100%-done')).toBe('100%-done')
  })
})

describe('sinceLabel', () => {
  it('speaks in seconds, then minutes', () => {
    expect(sinceLabel(now - 2_000, now)).toBe('just now')
    expect(sinceLabel(now - 40_000, now)).toBe('40 s ago')
    expect(sinceLabel(now - 300_000, now)).toBe('5 min ago')
  })
})
