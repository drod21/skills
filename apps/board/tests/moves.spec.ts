// Moving cards: by drag (a mouse on the desktop, a touch long-press on the phone), by the Move to menu, with the text
// a move asks for, and Clear. Every test makes its own tasks on the moves board and checks the board file, not just
// the page, because the file is where a move is real.
import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { MOVES_BOARD } from './e2e-env'
import { centerOf, gripOf, hold, shot } from './drag'
import { addTask, claimTask, cli, cliJson } from './temp-board'

type ColumnId = 'needs' | 'open' | 'progress' | 'done' | 'cancelled'
type Shown = { status: string; owner: string | null; archived?: boolean; decisions: { kind: string; text?: string }[] }

const SECOND = { timeout: 2000 }
const LEAD = 'lead-session'

const taskOf = (id: number): Shown => cliJson<Shown>(MOVES_BOARD, ['show', String(id)])
const statusOf = (id: number) => taskOf(id).status
const everything = (id: number) => JSON.stringify(taskOf(id))
const titleOf = (info: TestInfo, label: string) => `${label} ${info.project.name} ${Date.now()}`

/** A task a worker holds. A `lead` task needs no check to finish, so it can be dragged to Done. */
function claimedTask(title: string, role: 'lead' | 'ux-worker'): number {
  const id = addTask(MOVES_BOARD, role, title)
  claimTask(MOVES_BOARD, role, role === 'lead' ? LEAD : 'worker-ux', id)
  return id
}

function closedTask(title: string): number {
  const id = addTask(MOVES_BOARD, 'qa-worker', title)
  cli(MOVES_BOARD, ['cancel', String(id)])
  return id
}

const cardIn = (page: Page, column: ColumnId, id: number) => page.locator(`#column-${column} [data-task-id="${id}"]`)

/** Below 1024 px the columns sit behind a tab strip; on a desktop all five show and there is nothing to click. */
async function showColumn(page: Page, id: ColumnId) {
  const tab = page.locator(`#tab-${id}`)
  if (await tab.isVisible()) await tab.click()
  return page.locator(`#column-${id}`)
}

/** Where a drop on a column lands: its tab on a phone, its heading on a desktop. */
async function dropPoint(page: Page, id: ColumnId) {
  const tab = page.locator(`#tab-${id}`)
  return centerOf((await tab.isVisible()) ? tab : page.locator(`#heading-${id}`))
}

async function lift(page: Page, column: ColumnId, id: number) {
  await showColumn(page, column)
  const card = cardIn(page, column, id)
  await expect(card).toBeVisible(SECOND)
  const held = await hold(page, await gripOf(card))
  // The ghost is the card in the hand; the board has been asked where this card can go once the line says it.
  await expect(page.locator('.drag-ghost')).toBeVisible()
  await expect(page.locator('.dock-line')).not.toContainText('Asking the board')
  return held
}

const dockLine = (page: Page) => page.locator('.dock-line')
const sheet = (page: Page) => page.getByRole('dialog')
const moveTo = (page: Page, column: ColumnId, id: number) =>
  cardIn(page, column, id).getByRole('button', { name: `Move to (task ${id})` })
const primary = (sheetEl: Locator) => sheetEl.locator('[data-primary="true"]')

async function chooseFromMenu(page: Page, column: ColumnId, id: number, label: string) {
  await showColumn(page, column)
  await moveTo(page, column, id).click()
  await expect(sheet(page)).toBeVisible()
  await sheet(page)
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Team board' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
})

test.describe('drag', () => {
  test('a legal drag changes the status on the board file', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Drag to done'), 'lead')
    const held = await lift(page, 'progress', id)
    await shot(page, 'drag-lifted')
    await held.moveTo(await dropPoint(page, 'done'))
    await expect(dockLine(page)).toContainText('Mark done')
    await shot(page, 'drag-over-done')
    await held.drop()

    await expect.poll(() => statusOf(id)).toBe('done')
    await showColumn(page, 'done')
    await expect(cardIn(page, 'done', id)).toBeVisible()
    await expect(cardIn(page, 'progress', id)).toHaveCount(0)
  })

  test('an illegal drop is refused with the board reason and the card goes back', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Drag refused'), 'ux-worker')
    const held = await lift(page, 'progress', id)
    await held.moveTo(await dropPoint(page, 'done'))
    // While it is over a place it cannot go, the line says why, in the board's words.
    await expect(dockLine(page)).toContainText('is not done-able')
    await shot(page, 'drag-refused')
    await held.drop()

    await expect(page.getByRole('alert')).toContainText('is not done-able')
    await showColumn(page, 'progress')
    await expect(cardIn(page, 'progress', id)).toBeVisible()
    expect(statusOf(id)).toBe('claimed')
  })

  test('a drop that lands nowhere does nothing', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Drag nowhere'), 'lead')
    const held = await lift(page, 'progress', id)
    await held.moveTo({ x: 4, y: 4 })
    await held.drop()
    await expect(page.locator('.drag-ghost')).toHaveCount(0)
    await expect(cardIn(page, 'progress', id)).toBeVisible()
    expect(statusOf(id)).toBe('claimed')
  })

  test('a board change while a card is lifted does not corrupt the view', async ({ page }, info) => {
    const lifted = claimedTask(titleOf(info, 'Lifted'), 'lead')
    const other = claimedTask(titleOf(info, 'Finished meanwhile'), 'lead')
    const held = await lift(page, 'progress', lifted)

    // Someone finishes another task from the terminal while this one is in the hand.
    cli(MOVES_BOARD, ['done', String(other), '--owner', LEAD])
    await expect(cardIn(page, 'progress', other)).toHaveCount(0, { timeout: 4000 })
    await expect(page.locator('.drag-ghost')).toBeVisible()
    await expect(cardIn(page, 'progress', lifted)).toHaveCount(1)

    await held.moveTo(await dropPoint(page, 'done'))
    await held.drop()
    await expect.poll(() => statusOf(lifted)).toBe('done')
    expect(statusOf(other)).toBe('done')
    // Each task is on the board exactly once.
    await expect(page.locator(`[data-task-id="${lifted}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-task-id="${other}"]`)).toHaveCount(1)
  })
})

test.describe('Move to', () => {
  test('costs a phone card a row of buttons and a desktop card none', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Button row'), 'lead')
    await showColumn(page, 'progress')
    const card = cardIn(page, 'progress', id)
    const actions = card.locator('.card-actions')
    const phone = (page.viewportSize()?.width ?? 0) < 1024
    await expect(actions).toHaveCSS('position', phone ? 'relative' : 'absolute')
    if (phone) return
    // Out of the way until the card is pointed at or focused, and still a named button for the keyboard.
    await expect(actions).toHaveCSS('opacity', '0')
    await card.hover()
    await expect(actions).toHaveCSS('opacity', '1')
    await moveTo(page, 'progress', id).focus()
    await expect(actions).toHaveCSS('opacity', '1')
  })

  test('does what a drag does: a legal choice moves the task', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Menu to done'), 'lead')
    await chooseFromMenu(page, 'progress', id, 'Done')
    await expect.poll(() => statusOf(id)).toBe('done')
    await showColumn(page, 'done')
    await expect(cardIn(page, 'done', id)).toBeVisible()
  })

  test('shows a refused move as unavailable, with the board reason', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Menu refused'), 'ux-worker')
    await showColumn(page, 'progress')
    await moveTo(page, 'progress', id).click()
    const row = sheet(page).getByRole('button', { name: /^Done/ })
    await expect(row).toHaveAttribute('aria-disabled', 'true')
    await expect(row).toContainText('is not done-able')
    await shot(page, 'move-to-menu')

    // Choosing it explains; it does not move anything.
    await row.click({ force: true })
    await expect(sheet(page)).toBeVisible()
    expect(statusOf(id)).toBe('claimed')
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toBeHidden()
  })
})

test.describe('a move that needs text', () => {
  test('cancel asks for a reason and sends it', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Cancel with reason'), 'ux-worker')
    await chooseFromMenu(page, 'progress', id, 'Cancelled')
    await shot(page, 'sheet-cancel')
    // Before anything is sent, the sheet says whose work in flight the cancel closes.
    await expect(sheet(page)).toContainText('worker-ux holds this task and may still be working on it')

    // The reason is required: an empty one is stopped in the sheet and nothing is sent.
    await primary(sheet(page)).click()
    await expect(sheet(page).getByRole('alert')).toContainText('Write at least a few words')
    expect(statusOf(id)).toBe('claimed')

    const reason = `Superseded by the new plan ${info.project.name}`
    await sheet(page).getByRole('textbox').fill(reason)
    await primary(sheet(page)).click()
    await expect.poll(() => statusOf(id)).toBe('cancelled')
    expect(everything(id)).toContain(reason)
    await expect(sheet(page)).toBeHidden()
  })

  test('release takes an optional reason and moves the task back to Open', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Release plain'), 'ux-worker')
    await chooseFromMenu(page, 'progress', id, 'Open')
    await expect(sheet(page)).toContainText('Releasing takes their claim away')
    await primary(sheet(page)).click()
    await expect.poll(() => statusOf(id)).toBe('open')
    expect(taskOf(id).owner).toBeNull()
    await showColumn(page, 'open')
    await expect(cardIn(page, 'open', id)).toBeVisible(SECOND)
  })

  test('start asks the lead with a prefilled, editable note', async ({ page }, info) => {
    const id = addTask(MOVES_BOARD, 'lead', titleOf(info, 'Start request'))
    await chooseFromMenu(page, 'open', id, 'In progress')
    const box = sheet(page).getByRole('textbox')
    await expect(box).toHaveValue(`Please start task ${id}`)
    await box.fill(`Please start task ${id} before the demo`)
    await primary(sheet(page)).click()

    await expect.poll(() => everything(id)).toContain(`Please start task ${id} before the demo`)
    // Asking moves nothing: the task is still open, and the page says it was sent.
    expect(statusOf(id)).toBe('open')
    await expect(page.getByRole('status').filter({ hasText: 'lead' })).toBeVisible()
  })

  test('a drop opens the same sheet', async ({ page }, info) => {
    const id = claimedTask(titleOf(info, 'Drop cancel'), 'ux-worker')
    const held = await lift(page, 'progress', id)
    await held.moveTo(await dropPoint(page, 'cancelled'))
    await held.drop()
    await expect(sheet(page)).toBeVisible()
    await shot(page, 'sheet-after-drop')
    await sheet(page).getByRole('textbox').fill('Dropped on Cancelled')
    await primary(sheet(page)).click()
    await expect.poll(() => statusOf(id)).toBe('cancelled')
  })
})

test.describe('Clear', () => {
  test('offers no Clear on work that is not finished, so nothing says cleared when it only cancels', async ({
    page,
  }, info) => {
    const id = claimedTask(titleOf(info, 'No clear on live work'), 'ux-worker')
    await showColumn(page, 'progress')
    await expect(cardIn(page, 'progress', id).getByRole('button', { name: /^Clear/ })).toHaveCount(0)
    await moveTo(page, 'progress', id).click()
    await expect(sheet(page).getByRole('button', { name: /^Cancelled/ })).toBeVisible()
    await expect(sheet(page).getByRole('button', { name: /clear/i })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toBeHidden()

    // A lifted card gets no Clear zone either.
    const held = await lift(page, 'progress', id)
    await expect(page.locator('.dock-clear')).toHaveCount(0)
    await held.moveTo({ x: 4, y: 4 })
    await held.drop()
    expect(statusOf(id)).toBe('claimed')
  })

  test('archives a closed task and the card leaves the board', async ({ page }, info) => {
    const id = closedTask(titleOf(info, 'Clear one'))
    await showColumn(page, 'cancelled')
    await expect(cardIn(page, 'cancelled', id)).toBeVisible(SECOND)
    await cardIn(page, 'cancelled', id)
      .getByRole('button', { name: `Clear (task ${id})` })
      .click()

    await expect(cardIn(page, 'cancelled', id)).toHaveCount(0)
    await expect.poll(() => taskOf(id).archived === true || taskOf(id).status === 'cancelled').toBe(true)
    // It is cleared, not gone: Show cleared brings it back to look at.
    const cancelled = page.locator('#column-cancelled')
    await cancelled.getByRole('button', { name: 'Show cleared' }).click()
    await expect(cardIn(page, 'cancelled', id)).toContainText('Cleared from the board')
    await cancelled.getByRole('button', { name: 'Hide cleared' }).click()
    await expect(cardIn(page, 'cancelled', id)).toHaveCount(0)
  })

  test('clear all asks first, with the count, then clears every closed card in view', async ({ page }, info) => {
    const added = [closedTask(titleOf(info, 'Clear all a')), closedTask(titleOf(info, 'Clear all b'))]
    const cancelled = await showColumn(page, 'cancelled')
    // The count is only the count once the page has both of them.
    for (const id of added) await expect(cardIn(page, 'cancelled', id)).toBeVisible({ timeout: 4000 })
    const button = cancelled.getByRole('button', { name: /^Clear all cancelled/ })
    const count = Number((await button.locator('.column-tool-count').textContent()) ?? '0')
    expect(count).toBeGreaterThanOrEqual(2)

    await button.click()
    await expect(sheet(page).getByRole('heading')).toContainText(`Clear ${count} cancelled tasks?`)
    await shot(page, 'sheet-clear-all')
    // Keeping them closes the sheet and clears nothing.
    await sheet(page).getByRole('button', { name: /^Keep/ }).click()
    await expect(sheet(page)).toBeHidden()
    await expect(cancelled.locator('[data-task-id]')).toHaveCount(count)

    await button.click()
    await primary(sheet(page)).click()
    await expect(cancelled.locator('[data-task-id]')).toHaveCount(0, { timeout: 15_000 })
  })
})
