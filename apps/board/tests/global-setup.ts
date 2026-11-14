import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import {
  E2E_BOARD,
  E2E_CLOSED,
  E2E_T3,
  E2E_T3_LOG,
  E2E_T3_MODE,
  MOVES_BOARD,
  MOVES_T3_LOG,
  MOVES_T3_MODE,
} from './e2e-env'
import { seedBoard } from './temp-board'

/** A fresh scratch board for the whole run. The app starts first and reads the board only when a page asks. */
export default function globalSetup() {
  seedBoard(E2E_BOARD, { closed: E2E_CLOSED })
  seedBoard(MOVES_BOARD, { closed: 3 })
  chmodSync(E2E_T3, 0o755)
  writeFileSync(E2E_T3_MODE, 'ok')
  rmSync(E2E_T3_LOG, { force: true })
  writeFileSync(MOVES_T3_MODE, 'ok')
  rmSync(MOVES_T3_LOG, { force: true })
}
