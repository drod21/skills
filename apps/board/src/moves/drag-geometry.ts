// The numbers a drag runs on, kept apart from the DOM so a test can hold them: how far a pointer must travel before it
// is a drag, how fast a list scrolls near its edge, and which edge of the screen switches the column.

/** A mouse starts a drag after this many pixels. A touch never does: it lifts a card by holding still. */
export const MOUSE_SLOP_PX = 6
/** How long a finger rests on a card before the card lifts. */
export const LONG_PRESS_MS = 250
/** A finger that travels this far before the press completes is scrolling, not lifting. */
export const TOUCH_SLOP_PX = 8
/** The band at the edge of a scroller where a drag scrolls it. */
export const EDGE_PX = 64
export const MAX_SCROLL_PX_PER_FRAME = 18
/** The band at the left and right of the screen where a dragged card switches the column. */
export const SIDE_EDGE_PX = 36
/** How long a card must wait on a tab or an edge before the column switches. */
export const SWITCH_DWELL_MS = 550

export const movedPast = (dx: number, dy: number, limit: number) => Math.hypot(dx, dy) > limit

/**
 * Pixels to scroll this frame for a pointer at `position` along a scroller from `start` to `end`: nothing in the
 * middle, faster the closer to the edge, and the top edge scrolls up (negative).
 */
export function edgeSpeed(position: number, start: number, end: number, edge = EDGE_PX, max = MAX_SCROLL_PX_PER_FRAME) {
  if (end - start < edge * 2) return 0
  if (position < start + edge) return -Math.round(max * Math.min(1, (start + edge - position) / edge))
  if (position > end - edge) return Math.round(max * Math.min(1, (position - (end - edge)) / edge))
  return 0
}

/** Which side of the screen the pointer is pressed against, or null. */
export function sideOf(x: number, width: number, edge = SIDE_EDGE_PX): -1 | 1 | null {
  if (x < edge) return -1
  if (x > width - edge) return 1
  return null
}
