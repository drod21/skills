import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { E2E_BOARD, E2E_CLOSED } from './e2e-env'
import { addTask, cli, claimTask, liveTasks } from './temp-board'

const WITHIN_TWO_SECONDS = { timeout: 2000 }

/** Below 1024 px the columns sit behind a tab strip; on a desktop all five show and there is nothing to click. */
async function showColumn(page: Page, id: 'needs' | 'open' | 'progress' | 'done' | 'cancelled') {
  const tab = page.locator(`#tab-${id}`)
  if (await tab.isVisible()) await tab.click()
  return page.locator(`#column-${id}`)
}

async function openFilters(page: Page) {
  const toggle = page.getByRole('button', { name: /^Filters/ })
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}

const cardIn = (page: Page, column: string, id: number) => page.locator(`#column-${column} [data-task-id="${id}"]`)
const columnOf = (status: string) => (status === 'claimed' ? 'progress' : 'open')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Team board' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
})

test('every open and claimed task on the board is a card', async ({ page }) => {
  const tasks = liveTasks(E2E_BOARD)
  expect(tasks.length).toBeGreaterThanOrEqual(9)
  for (const task of tasks) {
    const column = columnOf(task.status)
    await showColumn(page, column)
    await expect(cardIn(page, column, task.id), `task ${task.id} ${task.title}`).toBeVisible()
  }
})

test('shows the Needs me lane first, with the question that waits', async ({ page }) => {
  const tabs = page.getByRole('tablist', { name: 'Board columns' })
  if (await tabs.isVisible()) await expect(tabs.getByRole('tab').first()).toContainText('Needs me')
  const lane = await showColumn(page, 'needs')
  await expect(lane.getByText('Which tab opens first?')).toBeVisible()
  const headings = await page.locator('section.column h2').allTextContents()
  expect(headings[0]).toContain('Needs me')
})

test('does not scroll sideways', async ({ page }) => {
  for (const id of ['needs', 'open', 'progress', 'done', 'cancelled'] as const) {
    await showColumn(page, id)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `column ${id}`).toBeLessThanOrEqual(0)
  }
})

test('does not scroll sideways with the text at 200%', async ({ page }) => {
  // The person who zooms the text to read it on a wide screen: the controls row used to push the page 136 px wide.
  await page.addStyleTag({ content: 'html { font-size: 200% }' })
  for (const id of ['needs', 'open', 'progress', 'done', 'cancelled'] as const) {
    await showColumn(page, id)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `column ${id}`).toBeLessThanOrEqual(0)
  }
})

test('keeps controls at a touch size on a phone', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'the tab strip only exists on a phone or tablet')
  const targets = [
    page.getByRole('tab').first(),
    page.getByRole('button', { name: /^Filters/ }),
    page.getByRole('searchbox'),
  ]
  for (const target of targets) {
    const box = await target.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
})

test.describe('filters', () => {
  const live = () => liveTasks(E2E_BOARD)

  async function expectOnly(page: Page, wanted: ReturnType<typeof live>) {
    const wantedIds = new Set(wanted.map((task) => task.id))
    for (const task of live()) {
      const column = columnOf(task.status)
      await showColumn(page, column)
      const card = cardIn(page, column, task.id)
      if (wantedIds.has(task.id)) await expect(card, `task ${task.id} stays`).toBeVisible()
      else await expect(card, `task ${task.id} goes`).toHaveCount(0)
    }
  }

  test('role', async ({ page }) => {
    await openFilters(page)
    await page.getByLabel('Role').selectOption('ux-worker')
    await expectOnly(
      page,
      live().filter((task) => task.role === 'ux-worker'),
    )
  })

  test('tag', async ({ page }) => {
    await openFilters(page)
    await page.getByLabel('Tag').selectOption('server')
    await expectOnly(
      page,
      live().filter((task) => task.tag === 'server'),
    )
  })

  test('owner', async ({ page }) => {
    await openFilters(page)
    await page.getByLabel('Owner').selectOption({ value: 'worker-backend' })
    await expectOnly(
      page,
      live().filter((task) => task.owner === 'worker-backend'),
    )
  })

  test('text', async ({ page }) => {
    await page.getByRole('searchbox').fill('card list')
    await expectOnly(
      page,
      live().filter((task) => task.title.toLowerCase().includes('card list')),
    )
  })

  test('a role and a tag together', async ({ page }) => {
    await openFilters(page)
    await page.getByLabel('Role').selectOption('qa-worker')
    await page.getByLabel('Tag').selectOption('verify')
    await expectOnly(
      page,
      live().filter((task) => task.role === 'qa-worker' && task.tag === 'verify'),
    )
  })
})

test('a board write shows up in under two seconds without a reload', async ({ page }, info) => {
  let navigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++
  })

  // A new task appears in Open.
  const title = `Live check ${info.project.name} ${Date.now()}`
  await showColumn(page, 'open')
  const id = addTask(E2E_BOARD, 'perf-worker', title, { tag: 'live' })
  await expect(cardIn(page, 'open', id)).toBeVisible(WITHIN_TWO_SECONDS)
  await expect(cardIn(page, 'open', id)).toContainText(title)

  // Claiming it moves it to In progress.
  claimTask(E2E_BOARD, 'perf-worker', 'worker-perf', id)
  await expect(cardIn(page, 'open', id)).toHaveCount(0, WITHIN_TWO_SECONDS)
  await showColumn(page, 'progress')
  await expect(cardIn(page, 'progress', id)).toBeVisible(WITHIN_TWO_SECONDS)

  // A note the lead has not read puts a marker on its card.
  cli(E2E_BOARD, ['note', String(id), `Marker check ${Date.now()}`, '--by', 'worker-perf'])
  await expect(cardIn(page, 'progress', id).getByText('Note unread')).toBeVisible(WITHIN_TWO_SECONDS)

  // The lead reading it changes the marker.
  cli(E2E_BOARD, ['note-read', String(id), '--by', 'lead'])
  await expect(cardIn(page, 'progress', id).getByText('Note read, no reply')).toBeVisible(WITHIN_TWO_SECONDS)
  await expect(cardIn(page, 'progress', id).getByText('Note unread')).toHaveCount(0)

  // Cancelling it moves it to Cancelled.
  cli(E2E_BOARD, ['cancel', String(id)])
  await expect(cardIn(page, 'progress', id)).toHaveCount(0, WITHIN_TWO_SECONDS)
  await showColumn(page, 'cancelled')
  await expect(cardIn(page, 'cancelled', id)).toBeVisible(WITHIN_TWO_SECONDS)

  expect(navigations).toBe(0)
})

test('keeps the last good board and says so when the board cannot be read', async ({ page }) => {
  const original = readFileSync(E2E_BOARD, 'utf8')
  const [first] = liveTasks(E2E_BOARD).filter((task) => task.status === 'open')
  if (!first) throw new Error('the scratch board has no open task')
  await showColumn(page, 'open')
  await expect(cardIn(page, 'open', first.id)).toBeVisible()

  try {
    writeFileSync(E2E_BOARD, '{ this is not a board')
    await expect(page.getByRole('alert')).toBeVisible(WITHIN_TWO_SECONDS)
    await expect(cardIn(page, 'open', first.id)).toBeVisible()
  } finally {
    writeFileSync(E2E_BOARD, original)
  }
  await expect(page.getByRole('alert')).toHaveCount(0, WITHIN_TWO_SECONDS)
})

test('pages older closed tasks in', async ({ page }) => {
  const cancelled = await showColumn(page, 'cancelled')
  const cards = cancelled.locator('[data-task-id]')
  await expect(cards).toHaveCount(50)
  await cancelled.getByRole('button', { name: 'Load older' }).click()
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(E2E_CLOSED)
  await expect(cancelled.getByRole('button', { name: 'Load older' })).toHaveCount(0)
  const done = await showColumn(page, 'done')
  await expect(done.locator('[data-task-id]')).toHaveCount(2)
})

test('opens a task page from its card and comes back', async ({ page }) => {
  const [first] = liveTasks(E2E_BOARD).filter((task) => task.status === 'open')
  if (!first) throw new Error('the scratch board has no open task')
  await showColumn(page, 'open')
  await cardIn(page, 'open', first.id).getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${first.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText(first.title)
  await expect(page.getByRole('textbox')).toBeVisible()
  await page.getByRole('link', { name: /board/i }).first().click()
  await expect(page).toHaveURL(/\/$/)
})
