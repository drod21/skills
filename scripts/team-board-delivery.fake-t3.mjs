#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const stdin = Buffer.concat(chunks).toString('utf8')
const log = process.env.TEAM_BOARD_FAKE_LOG
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv, stdin })}\n`)
const sleepMs = Number(process.env.TEAM_BOARD_FAKE_SLEEP_MS ?? '0')
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs))
process.stderr.write(process.env.TEAM_BOARD_FAKE_STDERR ?? '')
process.stdout.write(
  process.env.TEAM_BOARD_FAKE_STDOUT ?? JSON.stringify({ messageId: 'message:fake', runId: 'run:fake' }),
)
process.exit(Number(process.env.TEAM_BOARD_FAKE_EXIT ?? '0'))
