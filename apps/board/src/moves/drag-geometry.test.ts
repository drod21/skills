import { describe, expect, it } from 'vitest'
import { EDGE_PX, MAX_SCROLL_PX_PER_FRAME, edgeSpeed, movedPast, sideOf } from './drag-geometry'

describe('edgeSpeed', () => {
  it('does not scroll in the middle of the scroller', () => {
    expect(edgeSpeed(300, 0, 600)).toBe(0)
  })

  it('scrolls up near the top and down near the bottom, faster at the very edge', () => {
    expect(edgeSpeed(EDGE_PX / 2, 0, 600)).toBeLessThan(0)
    expect(edgeSpeed(600 - EDGE_PX / 2, 0, 600)).toBeGreaterThan(0)
    expect(edgeSpeed(0, 0, 600)).toBe(-MAX_SCROLL_PX_PER_FRAME)
    expect(edgeSpeed(600, 0, 600)).toBe(MAX_SCROLL_PX_PER_FRAME)
    expect(Math.abs(edgeSpeed(4, 0, 600))).toBeGreaterThan(Math.abs(edgeSpeed(EDGE_PX - 4, 0, 600)))
  })

  it('stays at the maximum when the pointer is past the edge', () => {
    expect(edgeSpeed(-40, 0, 600)).toBe(-MAX_SCROLL_PX_PER_FRAME)
    expect(edgeSpeed(700, 0, 600)).toBe(MAX_SCROLL_PX_PER_FRAME)
  })

  it('does not scroll a scroller too short to have a middle', () => {
    expect(edgeSpeed(10, 0, EDGE_PX)).toBe(0)
  })
})

describe('movedPast', () => {
  it('measures the straight-line distance', () => {
    expect(movedPast(3, 4, 4.9)).toBe(true)
    expect(movedPast(3, 4, 5)).toBe(false)
  })
})

describe('sideOf', () => {
  it('names the edge the pointer is against', () => {
    expect(sideOf(10, 390)).toBe(-1)
    expect(sideOf(380, 390)).toBe(1)
    expect(sideOf(195, 390)).toBeNull()
  })
})
