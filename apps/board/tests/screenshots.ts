// Screenshots of a running board at the two widths that matter: `bun tests/screenshots.ts <url> <outDir>`.
// It only reads the page; it never writes to the board.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const [url, outDir] = process.argv.slice(2)
if (!url || !outDir) {
  console.error('usage: bun tests/screenshots.ts <url> <outDir>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const SHOTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
] as const

const browser = await chromium.launch()
try {
  for (const { name, ...context } of SHOTS) {
    const page = await (await browser.newContext(context)).newPage()
    await page.goto(url)
    await page.getByRole('heading', { name: 'Team board' }).waitFor()
    // The first column has content once the view has arrived.
    await page.locator('[data-column]').first().waitFor()
    await page.getByText('Live', { exact: true }).waitFor()
    const path = join(outDir, `board-${name}.png`)
    await page.screenshot({ path })
    console.log(path)
  }
} finally {
  await browser.close()
}
