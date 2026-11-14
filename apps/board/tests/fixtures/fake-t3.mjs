#!/usr/bin/env node
// A stand-in for the `t3` binary in the browser check. It never reaches a real T3 thread: `thread list` prints a
// fixed list for the lead picker, and every other call goes to scripts/team-board-delivery.fake-t3.mjs, the fake the
// delivery tests use. A test changes how sends behave by writing one word to the file named by
// TEAM_BOARD_FAKE_MODE_FILE: `ok` (the default), `fail` (exit 1 with a reason) or `slow` (answer after 1.5 s).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)

if (args[0] === 'thread' && args[1] === 'list') {
  process.stdout.write(
    JSON.stringify([
      { threadId: 'thread:alpha', title: 'Lead session, Monday', status: 'running', updatedAt: '2026-11-10T09:00:00Z' },
      { threadId: 'thread:beta', title: 'Lead session, Tuesday', status: 'idle', updatedAt: '2026-11-09T09:00:00Z' },
      {
        threadId: 'thread:child',
        title: 'A worker',
        status: 'idle',
        updatedAt: '2026-11-09T08:00:00Z',
        parentThreadId: 'thread:alpha',
      },
    ]),
  )
  process.exit(0)
}

const modeFile = process.env.TEAM_BOARD_FAKE_MODE_FILE
let mode = 'ok'
try {
  if (modeFile) mode = readFileSync(modeFile, 'utf8').trim() || 'ok'
} catch {
  // No mode file yet: send normally.
}

const env = { ...process.env }
if (mode === 'fail') {
  env.TEAM_BOARD_FAKE_EXIT = '1'
  env.TEAM_BOARD_FAKE_STDERR = 'thread not found'
}
if (mode === 'slow') env.TEAM_BOARD_FAKE_SLEEP_MS = '1500'

const real = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'team-board-delivery.fake-t3.mjs')
const child = spawn(process.execPath, [real, ...args], { stdio: 'inherit', env })
child.on('close', (code) => process.exit(code ?? 1))
