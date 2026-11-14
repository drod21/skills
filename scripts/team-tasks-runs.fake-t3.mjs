#!/usr/bin/env node
// Fake `t3` for `thread show <id> --json --messages 0`. TEAM_BOARD_FAKE_MAP is a JSON object keyed by thread id:
//   { "<threadId>": { "stdout": "...", "stderr": "...", "exit": 0, "sleepMs": 0 } }
// A thread that is not in the map answers like the real binary does for an unknown id (exit 1, empty stdout).
// Each call appends `{ argv }` as one JSON line to TEAM_BOARD_FAKE_LOG.
import { appendFileSync } from 'node:fs'

const log = process.env.TEAM_BOARD_FAKE_LOG
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv })}\n`)

const map = JSON.parse(process.env.TEAM_BOARD_FAKE_MAP ?? '{}')
const argv = process.argv.slice(2)
const threadId = argv[0] === 'thread' && argv[1] === 'show' ? argv[2] : undefined
const entry = threadId !== undefined && Object.hasOwn(map, threadId) ? map[threadId] : undefined

if (!entry) {
  process.stderr.write(`Thread ${threadId} is no longer available.\n`)
  process.exit(1)
}
if (Number(entry.sleepMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(entry.sleepMs)))
process.stderr.write(entry.stderr ?? '')
process.stdout.write(entry.stdout ?? '')
process.exit(Number(entry.exit ?? 0))
