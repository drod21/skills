// One card's drag, from the press to the drop, on platform pointer events. A mouse lifts the card after a few pixels of
// travel. A finger lifts it by resting on it, so a swipe still scrolls the list. The lifted card is a clone that follows
// the pointer; the real card stays put, dimmed, until the move is decided. No React in here: the page hears about it
// through `DragEnv`, and everything it draws while dragging is a data attribute CSS reads.
import {
  EDGE_PX,
  LONG_PRESS_MS,
  MOUSE_SLOP_PX,
  SWITCH_DWELL_MS,
  TOUCH_SLOP_PX,
  edgeSpeed,
  movedPast,
  sideOf,
} from './drag-geometry'
import { TARGET_IDS, type TargetId } from './moves-contract'

/** The gap the card in the hand keeps from the left and right of the screen. */
const GHOST_MARGIN_PX = 8

/** Where a held card has waited long enough to switch the visible column. */
export type DwellSpot = { column: string } | { side: -1 | 1 }

export type DragEnv = {
  /** The card lifted. */
  onLift: () => void
  /** The target under the pointer changed; null over nothing a card can be dropped on. */
  onOver: (target: TargetId | null) => void
  /** The pointer rested on a column tab or a screen edge. */
  onDwell: (spot: DwellSpot) => void
  /** Released. `drop`: the move is under way, so the clone melts away. `return`: it flies back to its card. */
  onDrop: (target: TargetId | null) => 'drop' | 'return'
  /** The gesture is over, lifted or not. */
  onEnd: () => void
}

/** Set while a card is lifted, so the one page-wide touchmove listener knows to hold the page still. */
let lifted = false
let blockerInstalled = false

/**
 * A finger moving on the page scrolls it unless a non-passive touchmove listener cancels the move. Browsers decide
 * that from the listeners that exist when the touch starts, so this one is installed once and stays.
 */
function installBlocker() {
  if (blockerInstalled) return
  blockerInstalled = true
  window.addEventListener(
    'touchmove',
    (event) => {
      if (lifted && event.cancelable) event.preventDefault()
    },
    { passive: false },
  )
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const asTarget = (value: string | undefined): TargetId | null => TARGET_IDS.find((id) => id === value) ?? null

function scrollerAt(stack: readonly Element[]): HTMLElement | null {
  for (const element of stack) {
    const list =
      element.closest<HTMLElement>('.list') ?? element.closest('.column')?.querySelector<HTMLElement>('.list')
    if (!list) continue
    const scrolls =
      list.scrollHeight > list.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(list).overflowY)
    return scrolls ? list : null
  }
  return null
}

export function beginGesture(start: PointerEvent, card: HTMLElement, env: DragEnv): void {
  installBlocker()
  const touch = start.pointerType !== 'mouse'
  const origin = card.getBoundingClientRect()
  const grab = { x: start.clientX - origin.left, y: start.clientY - origin.top }
  let x = start.clientX
  let y = start.clientY
  let ghost: HTMLElement | null = null
  let over: TargetId | null = null
  let frame = 0
  let holdTimer = 0
  let dwell: { key: string; timer: number } | null = null

  const place = () => {
    if (!ghost) return
    // A card dragged to a tab at the screen edge stays whole on the screen instead of running off it.
    const room = Math.max(0, document.documentElement.clientWidth - ghost.offsetWidth - GHOST_MARGIN_PX)
    const left = Math.min(Math.max(x - grab.x, GHOST_MARGIN_PX), room)
    ghost.style.translate = `${left}px ${y - grab.y}px`
  }

  const clearDwell = () => {
    if (dwell) window.clearTimeout(dwell.timer)
    dwell = null
  }

  const watchDwell = (spot: DwellSpot | null) => {
    const key = spot === null ? '' : 'column' in spot ? `tab:${spot.column}` : `side:${spot.side}`
    if (dwell?.key === key) return
    clearDwell()
    if (spot === null) return
    dwell = {
      key,
      timer: window.setTimeout(() => {
        dwell = null
        env.onDwell(spot)
      }, SWITCH_DWELL_MS),
    }
  }

  /** Update what is under the pointer, and keep the dwell timers in step with it. */
  const look = () => {
    const stack = document.elementsFromPoint(x, y)
    let hit: HTMLElement | null = null
    for (const element of stack) {
      // A column tab or column is a spot even when it is not a place a card can go (Needs me): it still switches.
      hit = element.closest<HTMLElement>('[data-drop-target], [data-drop-column]')
      if (hit) break
    }
    const next = asTarget(hit?.dataset.dropTarget)
    if (next !== over) {
      over = next
      env.onOver(over)
    }
    const side = sideOf(x, window.innerWidth)
    watchDwell(hit?.dataset.dropColumn ? { column: hit.dataset.dropColumn } : side === null ? null : { side })
    return stack
  }

  const pump = () => {
    frame = requestAnimationFrame(pump)
    const stack = look()
    const list = scrollerAt(stack)
    if (list) {
      const box = list.getBoundingClientRect()
      const speed = edgeSpeed(y, box.top, box.bottom)
      if (speed !== 0) list.scrollTop += speed
      return
    }
    const dock = document.querySelector('[data-drag-dock]')?.getBoundingClientRect()
    const bottom = dock ? Math.min(window.innerHeight, dock.top) : window.innerHeight
    const speed = edgeSpeed(y, 0, bottom, EDGE_PX)
    if (speed !== 0) window.scrollBy(0, speed)
  }

  const lift = () => {
    window.clearTimeout(holdTimer)
    const clone = card.cloneNode(true) as HTMLElement
    clone.removeAttribute('data-task-id')
    clone.setAttribute('aria-hidden', 'true')
    clone.setAttribute('inert', '')
    clone.classList.add('drag-ghost')
    clone.style.width = `${origin.width}px`
    clone.style.height = `${origin.height}px`
    ghost = clone
    place()
    document.body.append(clone)
    card.dataset.dragging = 'true'
    document.body.dataset.dragging = 'true'
    lifted = true
    navigator.vibrate?.(8)
    env.onLift()
    look()
    frame = requestAnimationFrame(pump)
  }

  const remove = (element: HTMLElement) => element.remove()

  const settle = (how: 'drop' | 'return', ghostElement: HTMLElement) => {
    if (how === 'drop' || reducedMotion()) {
      if (how === 'drop' && !reducedMotion()) {
        ghostElement.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out' }).finished.then(
          () => remove(ghostElement),
          () => remove(ghostElement),
        )
      } else {
        remove(ghostElement)
      }
      return
    }
    // Back to where the card is now: it may have scrolled while it was held.
    const home = card.getBoundingClientRect()
    ghostElement
      .animate([{ translate: ghostElement.style.translate }, { translate: `${home.left}px ${home.top}px` }], {
        duration: 200,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        fill: 'forwards',
      })
      .finished.then(
        () => remove(ghostElement),
        () => remove(ghostElement),
      )
  }

  const end = (how: 'drop' | 'return' | 'none') => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key)
    window.removeEventListener('selectstart', block)
    window.removeEventListener('contextmenu', block)
    window.clearTimeout(holdTimer)
    clearDwell()
    cancelAnimationFrame(frame)
    lifted = false
    delete document.body.dataset.dragging
    delete card.dataset.dragging
    if (ghost && how !== 'none') settle(how, ghost)
    else ghost?.remove()
    if (how !== 'none') {
      // The click that follows a drag must not open the card it started on. A tap anywhere else soon after is a new
      // tap, not the tail of this drag, so it goes through.
      const swallow = (event: Event) => {
        window.removeEventListener('click', swallow, { capture: true })
        if (event.target instanceof Node && event.target.contains(card)) event.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400)
    }
    env.onEnd()
  }

  const move = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return
    x = event.clientX
    y = event.clientY
    if (ghost) {
      place()
      return
    }
    const far = movedPast(x - start.clientX, y - start.clientY, touch ? TOUCH_SLOP_PX : MOUSE_SLOP_PX)
    if (!far) return
    // A finger that travels before it has rested is scrolling the list; leave it to the browser.
    if (touch) end('none')
    else lift()
  }

  const up = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return
    if (!ghost) return end('none')
    end(env.onDrop(over))
  }

  const cancel = (event: PointerEvent) => {
    if (event.pointerId === start.pointerId) end(ghost ? 'return' : 'none')
  }

  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && ghost) end('return')
  }

  const block = (event: Event) => {
    if (touch || ghost || event.type === 'selectstart') event.preventDefault()
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key)
  window.addEventListener('selectstart', block)
  window.addEventListener('contextmenu', block)
  if (touch) holdTimer = window.setTimeout(lift, LONG_PRESS_MS)
}
