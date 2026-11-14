// The task thread in a real browser, on both screens, against the scratch board and a stand-in for `t3`. Each test
// makes its own task and sets the board's lead address and the stand-in's mode itself, so order does not matter.
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { E2E_BOARD, E2E_T3_LOG, E2E_T3_MODE } from './e2e-env'
import { addWorkerTask, cli, cliJson, judgeCheck } from './temp-board'

const LEAD = 'thread:lead'
const setMode = (mode: 'ok' | 'fail' | 'slow') => writeFileSync(E2E_T3_MODE, mode)
const setLead = (threadId: string | null) =>
  cli(E2E_BOARD, threadId === null ? ['lead-wake', '--clear', '--by', 'lead'] : ['lead-wake', threadId, '--by', 'lead'])
const sends = () =>
  readFileSync(E2E_T3_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })

let serial = 0
const unique = (name: string, project: string) => `${name} ${project} ${Date.now()}-${serial++}`

test.beforeEach(() => {
  setMode('ok')
  setLead(LEAD)
})

async function openTask(page: Page, id: number) {
  await page.goto(`/tasks/${id}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

const composer = (page: Page) => page.getByRole('textbox')

test('a task with nothing said shows an empty thread, and a note reaches the lead and the worker', async ({
  page,
}, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Empty thread', info.project.name), 'worker-empty')
  setMode('slow')
  await openTask(page, id)
  await expect(page.locator('[data-state="empty"]')).toContainText('Nothing has been said')
  await expect(page.getByText('Goes to the lead and to the worker on the claim.')).toBeVisible()

  const note = `Please look at the empty state first (${info.project.name})`
  await composer(page).fill(note)
  await page.getByRole('button', { name: 'Send note' }).click()

  // Sending: the text left the box, the message is on the thread, and the board has not delivered it yet.
  await expect(composer(page)).toHaveValue('')
  await expect(page.locator('.message[data-from="owner"]')).toContainText(note)
  await expect(
    page
      .locator('.delivery')
      .filter({ hasText: /Waiting to send|Sending to/ })
      .first(),
  ).toBeVisible()

  // Delivered, with the time, to both.
  await expect(page.locator('.delivery[data-tone="good"]')).toHaveCount(2, { timeout: 15_000 })
  await expect(page.locator('.delivery').filter({ hasText: /Delivered to the lead at \d{1,2}:\d{2}/ })).toBeVisible()
  await expect(page.locator('.delivery').filter({ hasText: /Delivered to the worker at \d{1,2}:\d{2}/ })).toBeVisible()
  const sent = sends().filter((entry) => entry.stdin.includes(note))
  expect(sent.length).toBe(2)
})

test('an answer to the open question goes to the worker and shows delivered', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Question', info.project.name), 'worker-asks')
  cli(E2E_BOARD, ['ask-owner', String(id), 'Which tab opens first?', '--by', 'worker-asks'])
  await openTask(page, id)
  await expect(page.locator('.message[data-from="agent"]')).toContainText('Which tab opens first?')
  await expect(page.getByLabel('Answer the question')).toBeVisible()
  await expect(page.getByText('Goes to the worker on the claim.')).toBeVisible()

  await composer(page).fill('Needs me opens first')
  await page.getByRole('button', { name: 'Send answer' }).click()
  await expect(page.locator('.message[data-from="owner"]')).toContainText('Needs me opens first')
  await expect(page.locator('.delivery').filter({ hasText: /Delivered to the worker at \d{1,2}:\d{2}/ })).toBeVisible({
    timeout: 15_000,
  })
  // The question is answered, so the box is a note box again.
  await expect(page.getByLabel('Note to the lead')).toBeVisible()
})

test('a task with no thread address says so, keeps the message, and points to the setting', async ({ page }, info) => {
  setLead(null)
  const id = addWorkerTask(E2E_BOARD, unique('No address', info.project.name), 'worker-silent', null)
  await openTask(page, id)
  await expect(page.locator('[data-state="no-address"]')).toContainText('No thread to wake')
  await composer(page).fill('Anyone there?')
  await page.getByRole('button', { name: 'Send note' }).click()
  const stuck = page.locator('.delivery[data-tone="attention"]').filter({ hasText: /No thread to send to/ })
  await expect(stuck.first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message[data-from="owner"]')).toContainText('Anyone there?')
  await stuck.first().getByRole('link', { name: 'Set the lead thread' }).click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('a delivery that gave up shows its reason and attempts, and Retry sends it', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Gives up', info.project.name), 'worker-down')
  setMode('fail')
  await openTask(page, id)
  await composer(page).fill('Are you still there?')
  await page.getByRole('button', { name: 'Send note' }).click()
  await expect(
    page.locator('.delivery').filter({ hasText: /Could not reach the lead \(1 attempt so far\)/ }),
  ).toBeVisible({
    timeout: 15_000,
  })

  // Five more sweeps, each after its backoff, take it to the sixth and last attempt.
  for (let hour = 1; hour <= 5; hour++) {
    process.env.TEAM_BOARD_NOW = new Date(Date.now() + hour * 60 * 60_000).toISOString()
    cli(E2E_BOARD, ['deliver'])
  }
  delete process.env.TEAM_BOARD_NOW
  const failed = page.locator('.delivery[data-tone="attention"]').filter({ hasText: /after 6 attempts: .+/ })
  await expect(failed.first()).toBeVisible({ timeout: 15_000 })

  setMode('ok')
  await failed.first().getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.delivery').filter({ hasText: /Delivered to the lead at \d{1,2}:\d{2}/ })).toBeVisible({
    timeout: 15_000,
  })
})

test('a send the server refuses leaves the text in the box and says why', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Refused', info.project.name), 'worker-refused')
  await page.route(`**/api/thread/${id}/send`, (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, failure: { kind: 'spawn', message: 'cannot run the board CLI: boom' } }),
    }),
  )
  await openTask(page, id)
  await composer(page).fill('This must not vanish')
  await page.getByRole('button', { name: 'Send note' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Not sent: cannot run the board CLI: boom' })).toBeVisible()
  await expect(composer(page)).toHaveValue('This must not vanish')
  await expect(page.locator('.message[data-from="owner"]')).toHaveCount(0)
})

test('text that starts with two dashes is refused by the board and stays in the box', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Dashes', info.project.name), 'worker-dash')
  await openTask(page, id)
  await composer(page).fill('--by someone')
  await page.getByRole('button', { name: 'Send note' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'must not start with --' })).toBeVisible()
  await expect(composer(page)).toHaveValue('--by someone')
})

test('a board that cannot be read says so and offers Retry, then recovers', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Unreadable', info.project.name), 'worker-gone')
  let down = true
  await page.route(new RegExp(`/api/thread/${id}$`), (route) => (down ? route.abort() : route.continue()))
  await page.goto(`/tasks/${id}`)
  await expect(page.locator('[data-state="unreadable"]')).toContainText('Cannot read the board')
  down = false
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Unreadable`)
})

test('a task the board does not have says so', async ({ page }) => {
  await page.goto('/tasks/999999')
  await expect(page.locator('[data-state="missing"]')).toContainText('no task #999999')
})

test('the thread follows the board live, with no reload', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Live', info.project.name), 'worker-live')
  await openTask(page, id)
  cli(E2E_BOARD, ['note', String(id), 'Is this live?', '--by', 'owner'])
  await expect(page.locator('.message[data-from="owner"]')).toContainText('Is this live?', { timeout: 5_000 })
  cli(E2E_BOARD, ['note-read', String(id), '--by', 'lead'])
  await expect(page.locator('.event')).toContainText('read your note', { timeout: 5_000 })
})

test('the thread page does not scroll sideways and its controls are touch size', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Layout', info.project.name), 'worker-layout')
  cli(E2E_BOARD, [
    'ask-owner',
    String(id),
    `A long question ${'with many words '.repeat(20)}and a long_unbroken_token_${'x'.repeat(80)}`,
    '--by',
    'worker-layout',
  ])
  await openTask(page, id)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  for (const locator of [
    page.getByRole('button', { name: 'Send answer' }),
    composer(page),
    page.getByRole('link', { name: 'Board' }),
  ]) {
    const box = await locator.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5)
  }
})

test('a held check is accepted from the Needs me lane, with a reason', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Held check', info.project.name), 'worker-held')
  judgeCheck(E2E_BOARD, id, 'worker-held', 'hold')
  await page.goto('/')
  const tab = page.locator('#tab-needs')
  if (await tab.isVisible()) await tab.click()
  const card = page.locator(`#column-needs [data-task-id="${id}"]`)
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Accept the check' }).click()

  const sheet = page.getByRole('dialog')
  const accept = sheet.getByRole('button', { name: 'Accept check' })
  await expect(accept).toBeDisabled()
  await sheet.getByRole('textbox').fill('I read the log myself and it shows the fix')
  await accept.click()
  await expect(sheet).toBeHidden()
  await expect(card).toHaveCount(0, { timeout: 5_000 })
  const entries = cliJson<{ decisions: { kind: string; by: string; reason?: string }[] }>(E2E_BOARD, [
    'show',
    String(id),
  ])
  expect(entries.decisions.find((entry) => entry.kind === 'accept')).toMatchObject({
    by: 'owner',
    reason: 'I read the log myself and it shows the fix',
  })
})

test('a held check can be accepted from the task page too', async ({ page }, info) => {
  const id = addWorkerTask(E2E_BOARD, unique('Held on page', info.project.name), 'worker-held-page')
  judgeCheck(E2E_BOARD, id, 'worker-held-page', 'hold')
  await openTask(page, id)
  await page.getByRole('button', { name: 'Accept the check' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('textbox').fill('Confirmed by hand')
  await sheet.getByRole('button', { name: 'Accept check' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.locator('.event')).toContainText('accepted the held check', { timeout: 5_000 })
  await expect(page.getByRole('button', { name: 'Accept the check' })).toHaveCount(0)
})

test('Needs me counts what the owner can act on, and keeps rejected checks in their own group', async ({
  page,
}, info) => {
  const rejected = addWorkerTask(E2E_BOARD, unique('Rejected check', info.project.name), 'worker-rejected')
  judgeCheck(E2E_BOARD, rejected, 'worker-rejected', 'rejected')
  const view = cliJson<{ needsOwner: { id: number; reasons: { why: string }[] }[] }>(E2E_BOARD, ['view'])
  const actionable = view.needsOwner.filter((row) => row.reasons.some((reason) => reason.why !== 'rejected'))
  const quiet = view.needsOwner.filter((row) => row.reasons.every((reason) => reason.why === 'rejected'))
  expect(quiet.map((row) => row.id)).toContain(rejected)

  await page.goto('/')
  const tab = page.locator('#tab-needs')
  if (await tab.isVisible()) {
    await tab.click()
    await expect(tab.locator('.tab-count')).toHaveText(String(actionable.length))
  }
  const column = page.locator('#column-needs')
  await expect(column.locator('.group-title[data-group="rejected"]')).toContainText(`Rejected checks ${quiet.length}`)
  await expect(column.locator(`[data-task-id="${rejected}"]`)).toBeVisible()
  await expect(
    column.locator(`[data-task-id="${rejected}"]`).getByRole('button', { name: 'Accept the check' }),
  ).toHaveCount(0)
})

test('the lead thread can be set for the board and for a tag, and cleared', async ({ page }) => {
  setLead(null)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Lead thread' })).toBeVisible()
  const board = page.locator('[data-scope="board"]')
  await board.getByLabel('Thread').selectOption({ label: 'Lead session, Monday' })
  await board.getByRole('button', { name: 'Save' }).click()
  await expect(board.getByRole('status')).toHaveText('Saved.')
  expect(cliJson<{ lead: { threadId: string } | null }>(E2E_BOARD, ['view']).lead?.threadId).toBe('thread:alpha')

  const boardTag = page.locator('[data-scope="tag"][data-tag="server"]')
  await boardTag.getByLabel('Thread').selectOption({ label: 'Lead session, Tuesday' })
  await boardTag.getByRole('button', { name: 'Save' }).click()
  await expect(boardTag.getByRole('status')).toHaveText('Saved.')
  expect(
    cliJson<{ leadTags?: Record<string, { threadId: string }> }>(E2E_BOARD, ['view']).leadTags?.server?.threadId,
  ).toBe('thread:beta')

  await boardTag.getByLabel('Thread').selectOption({ label: 'Use the board lead' })
  await boardTag.getByRole('button', { name: 'Save' }).click()
  await expect(boardTag.getByRole('status')).toHaveText('Cleared.')
  expect(cliJson<{ leadTags?: Record<string, unknown> }>(E2E_BOARD, ['view']).leadTags?.server).toBeUndefined()
})
