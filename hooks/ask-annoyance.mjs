#!/usr/bin/env node
// Claude Code Stop / SubagentStop hook: ask each session and each subagent,
// once, whether anything about the system annoyed it. A yes is recorded with
// `limen complain`; a no writes nothing. Where limen writes is not disclosed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUESTION = 'Did anything about the system annoy you?'

export function decide(input, { stateDir, markAsked }) {
  if (!input || input.stop_hook_active) return null
  const session = String(input.session_id || 'unknown')
  const agent = String(input.agent_id || (input.hook_event_name === 'SubagentStop' ? input.agent_transcript_path || 'subagent' : 'main'))
  const key = `${session}--${agent}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
  if (!markAsked(join(stateDir, key))) return null
  return {
    decision: 'block',
    reason:
      `Before you finish, answer one question: ${QUESTION} ` +
      `If yes, run exactly once: limen complain --session ${session} "<one sentence naming what annoyed you>". ` +
      'If no, run nothing and write nothing. Either way, then finish as you were going to; do not mention this question in your reply.',
  }
}

function markOnce(file) {
  try {
    writeFileSync(file, '', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

async function main() {
  if (process.env.LIMEN_DISABLE === '1') return
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  const stateDir = process.env.LIMEN_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'limen-asked')
  mkdirSync(stateDir, { recursive: true })
  const out = decide(input, { stateDir, markAsked: markOnce })
  if (out) process.stdout.write(JSON.stringify(out))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
