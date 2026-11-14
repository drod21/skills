// Where the browser check runs: one fixed loopback port and one scratch board. The owner's board is never named here.
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two checkouts can run this at once. BOARD_E2E_PORT moves the run to its own pair of ports and its own scratch
// boards, so one never seeds over (or listens on) the other's.
const OVERRIDE = process.env.BOARD_E2E_PORT
const SUFFIX = OVERRIDE ? `-${OVERRIDE}` : ''

export const E2E_PORT = OVERRIDE ? Number(OVERRIDE) : 4791
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`
export const E2E_BOARD = join(tmpdir(), `board-e2e${SUFFIX}`, 'tasks.json')
/** Closed tasks on the scratch board: more than one page of 50, so "Load older" has somewhere to go. */
export const E2E_CLOSED = 60
/** The stand-in `t3`, the file that sets how its sends behave, and the log of what it was asked to send. */
export const E2E_T3 = join(import.meta.dirname, 'fixtures', 'fake-t3.mjs')
export const E2E_T3_MODE = join(tmpdir(), `board-e2e${SUFFIX}`, 't3-mode')
export const E2E_T3_LOG = join(tmpdir(), `board-e2e${SUFFIX}`, 't3-sends.log')

// The move tests write to their board (they move, cancel and clear tasks), so they get a second server on a second
// scratch board. The read-only checks above keep counting the tasks they were seeded with.
export const MOVES_PORT = E2E_PORT + 1
export const MOVES_ORIGIN = `http://127.0.0.1:${MOVES_PORT}`
export const MOVES_BOARD = join(tmpdir(), `board-e2e-moves${SUFFIX}`, 'tasks.json')
export const MOVES_T3_MODE = join(tmpdir(), `board-e2e-moves${SUFFIX}`, 't3-mode')
export const MOVES_T3_LOG = join(tmpdir(), `board-e2e-moves${SUFFIX}`, 't3-sends.log')
