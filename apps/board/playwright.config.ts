import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import {
  E2E_BOARD,
  E2E_ORIGIN,
  E2E_PORT,
  E2E_T3,
  E2E_T3_LOG,
  E2E_T3_MODE,
  MOVES_BOARD,
  MOVES_ORIGIN,
  MOVES_PORT,
  MOVES_T3_LOG,
  MOVES_T3_MODE,
} from './tests/e2e-env'
import { CLI } from './tests/temp-board'

// Two screens, one board: a 390 px phone and a 1280 px desktop. Both run against the built app on a scratch board,
// in one worker, so a write one test makes never lands in the middle of another. The move tests run the same two
// screens against a second server and board, because they change what the read-only checks count.
const phone = {
  ...devices['Desktop Chrome'],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
}
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
const MOVES_SPEC = /moves\.spec\.ts$/

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  globalSetup: './tests/global-setup.ts',
  outputDir: join(tmpdir(), 'board-e2e-results'),
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: 'list',
  use: { baseURL: E2E_ORIGIN, trace: 'off' },
  projects: [
    { name: 'phone', use: phone, testIgnore: MOVES_SPEC },
    { name: 'desktop', use: desktop, testIgnore: MOVES_SPEC },
    { name: 'moves-phone', use: { ...phone, baseURL: MOVES_ORIGIN }, testMatch: MOVES_SPEC },
    { name: 'moves-desktop', use: { ...desktop, baseURL: MOVES_ORIGIN }, testMatch: MOVES_SPEC },
  ],
  webServer: [
    {
      command: 'bun run build && bun run start',
      url: `${E2E_ORIGIN}/api/session`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        HOST: '127.0.0.1',
        PORT: String(E2E_PORT),
        TEAM_BOARD_CLI: CLI,
        TEAM_TASKS_FILE: E2E_BOARD,
        // Sends go to a stand-in, never to a real T3 thread.
        TEAM_BOARD_T3_BIN: E2E_T3,
        TEAM_BOARD_FAKE_MODE_FILE: E2E_T3_MODE,
        TEAM_BOARD_FAKE_LOG: E2E_T3_LOG,
      },
    },
    {
      // Built by the server above, which Playwright waits for first. Its own stand-in t3 and log, so no move can reach
      // a real thread and the two servers never share a send log.
      command: 'bun run start',
      url: `${MOVES_ORIGIN}/api/session`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        HOST: '127.0.0.1',
        PORT: String(MOVES_PORT),
        TEAM_BOARD_CLI: CLI,
        TEAM_TASKS_FILE: MOVES_BOARD,
        TEAM_BOARD_T3_BIN: E2E_T3,
        TEAM_BOARD_FAKE_MODE_FILE: MOVES_T3_MODE,
        TEAM_BOARD_FAKE_LOG: MOVES_T3_LOG,
      },
    },
  ],
})
