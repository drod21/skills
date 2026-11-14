// Drives a card by hand in the browser: a mouse press-and-move on a desktop, a real touch long-press (through the
// protocol's touch input, so the page sees touch pointer events) on a phone.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CDPSession, Locator, Page } from '@playwright/test'

export type Point = { x: number; y: number }

/** The touch hold that lifts a card is 250 ms in the app; wait a little longer than that. */
const HOLD_MS = 400
const STEPS = 14

export const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 1024

/** A point on the card's title row: on the card, clear of its Move to and Clear buttons. */
export async function gripOf(card: Locator): Promise<Point> {
  await card.scrollIntoViewIfNeeded()
  const box = await card.boundingBox()
  if (!box) throw new Error('the card has no box on the page')
  return { x: box.x + box.width * 0.4, y: box.y + 18 }
}

export async function centerOf(target: Locator): Promise<Point> {
  const box = await target.boundingBox()
  if (!box) throw new Error('the drop target has no box on the page')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export type Held = {
  moveTo: (point: Point) => Promise<void>
  drop: () => Promise<void>
}

const between = (from: Point, to: Point, step: number): Point => ({
  x: from.x + ((to.x - from.x) * step) / STEPS,
  y: from.y + ((to.y - from.y) * step) / STEPS,
})

async function holdWithTouch(page: Page, from: Point): Promise<Held> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: Point) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] })
  await touch('touchStart', from)
  await page.waitForTimeout(HOLD_MS)
  let at = from
  return {
    moveTo: async (point) => {
      for (let step = 1; step <= STEPS; step++) await touch('touchMove', between(at, point, step))
      at = point
    },
    drop: async () => {
      await touch('touchEnd')
      await cdp.detach()
    },
  }
}

async function holdWithMouse(page: Page, from: Point): Promise<Held> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Past the 6 px a mouse needs before a press becomes a lift.
  await page.mouse.move(from.x + 14, from.y + 6, { steps: 4 })
  return {
    moveTo: (point) => page.mouse.move(point.x, point.y, { steps: STEPS }),
    drop: () => page.mouse.up(),
  }
}

/** Press a card and hold it lifted. The caller moves it, looks at the page, and drops it. */
export const hold = (page: Page, from: Point): Promise<Held> =>
  isPhone(page) ? holdWithTouch(page, from) : holdWithMouse(page, from)

/** Screenshots for the pull request, only when T9_SHOTS names a folder. The test run never depends on them. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.T9_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}-${isPhone(page) ? 'phone' : 'desktop'}.png`) })
}
