import { describe, expect, it } from 'vitest'
import type { MoveOption } from './moves-contract'
import { canBeCleared, verbOf } from './targets'

describe('canBeCleared', () => {
  it('is true for finished work and false for work the board would only cancel', () => {
    expect(canBeCleared({ status: 'done' })).toBe(true)
    expect(canBeCleared({ status: 'cancelled' })).toBe(true)
    expect(canBeCleared({ status: 'open' })).toBe(false)
    expect(canBeCleared({ status: 'claimed' })).toBe(false)
    expect(canBeCleared({ status: 'a-status-added-later' })).toBe(false)
  })
})

describe('verbOf', () => {
  it('names a cancel a cancel, whichever target asked for it', () => {
    const cancel: Extract<MoveOption, { state: 'legal' }> = {
      state: 'legal',
      command: 'cancel',
      fields: [],
      notifies: [],
    }
    expect(verbOf('cancelled', cancel)).toBe('Cancel task')
    expect(verbOf('clear', cancel)).toBe('Cancel task')
  })
})
