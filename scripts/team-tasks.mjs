#!/usr/bin/env node
import { resolveBoardFile } from './team-board-path.mjs'
// Task board with atomic claiming and self-healing. Logic and its rules live in team-tasks.lib.mjs.
// Lock = mkdir (atomic, with an owner pid); write = backup + temp file + rename.
// Decision policy: exact facts first; unresolved judgments go worker -> Jev -> lead -> human if needed.
// jev-route.ts routes tasks; jev-decide.ts scores options; jev-ask.ts records a cheap judgment.
// Record judgments and choices under the actual owner, never --by jev. done enforces doneBlockers
// for a task that has accept, and does not call Jev. Guidance lives in
// skills/team-coordinator/SKILL.md. Existing route holds and tool-approval authority remain unchanged.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  abandonStaleEvidenceCheck,
  acceptEvidence,
  addEvidence,
  addJudgment,
  addTask,
  analyzeBoard,
  answerOwner,
  askOwner,
  archiveOne,
  archivePath,
  archiveTasks,
  attachJev,
  cancelTask,
  claimTask,
  decideTask,
  doneTask,
  endEvidenceCheck,
  drainHealEvents,
  heartbeatTask,
  inspectFiles,
  leadReply,
  listBoard,
  noteToLead,
  ownerInbox,
  parseReviewPacket,
  prepareGitProof,
  readAnswer,
  readArchiveMap,
  readBoard,
  readNote,
  recordGitProof,
  recordReview,
  reviewReport,
  reapClaims,
  retainEvidence,
  runHealth,
  runProbeTargets,
  releaseTask,
  reopenOwnerlessClaims,
  routeTask,
  setDependencies,
  setLeadWake,
  showTask,
  staleClaims,
  startEvidenceCheck,
  withBoard,
} from './team-tasks.lib.mjs'
import {
  boardScriptPath,
  DEFAULT_SWEEP_LIMIT,
  prepareSweep,
  retryDelivery,
  settleSweep,
} from './team-board-delivery.mjs'

// arktype compiles its validators at import, which adds ~90ms to every spawn. Only the check-* commands need it,
// so load it on demand instead of for every board command.
async function parseCheckArgs(raw, shape) {
  const { type } = await import('arktype')
  const value = type(shape)(JSON.parse(raw))
  if (value instanceof type.errors) throw new Error(value.summary)
  return value
}

const USAGE = [
  'usage: team-tasks.mjs',
  '  add <role> <title...> [--after <id,id>] [--route <route>] [--jev <json>] [--reason <text>] [--by <owner>]',
  '                                          [--accept <text>] [--tag <t>]',
  '                                          --accept is required for every role except lead.',
  '                                          --reason needs --route; --by needs a journaled decision.',
  '                                          --by jev is reserved for verdicts',
  '  jev <id> <json>                         store a verdict on an open or claimed task. A null',
  '                                          route with no route decision in the journal takes the',
  '                                          verdict, including needs_lead.',
  '                                          A lead route decision, needs_lead, a route that is not',
  '                                          the previous verdict route, or an unknown route stays',
  '                                          put. Done and cancelled are refused',
  '  claim <role> <owner> [--id <id>] [--run <kind>:<ref>] [--wake <threadId>]',
  '                                          a plain claim skips needs_lead and lead_workflow',
  '                                          claim --id <id> --run workflow:<runId> takes lead_workflow',
  '  heartbeat <id> [--owner <owner>] [--run <kind>:<ref>] [--wake <threadId>]',
  '  lead-wake <threadId> [--task <id> | --tag <tag>] --by <name>',
  '  lead-wake --clear [--task <id> | --tag <tag>] --by <name>',
  '                                          a tag address applies to that tag after the task address',
  '  done <id> [--owner <owner>] [--force] [--evidence <item>]',
  '                                          --evidence may be repeated; a comma stays inside one item.',
  '                                          A temp file, or any local file on a gated task, is copied',
  '                                          beside the board before the lock.',
  '                                          On an already-done task with an owner, --owner must match',
  '                                          unless --force',
  '  evidence <id> [--supporting] <item...>  attach paths or URLs. Supporting items are outside acceptance.',
  '  add ... --git-proof <file.json>       pin a Git proof requirement, optionally with --accept for mixed work.',
  '  verify-git <id> --by <owner>          verify the pinned Git proof mechanically.',
  '  review <id> <file.json> --by <owner>    record scored findings; retains every prior finding ID.',
  '  review-report <id>                     print all findings and every unfixed comment.',
  '  add ... --review                      require a scored review before done (empty findings allowed).',
  '                                          A gated task must be claimed',
  '  judgment <id> <json>                   append a Jev judgment. Done and cancelled are refused.',
  '                                          A gated task must be claimed. --by jev is reserved',
  '  accept <id> --reason <text> --by <name>',
  '                                          lead accepts evidence when the latest check is a hold and',
  '                                          no decision but a release followed it.',
  '                                          --by must differ from the task owner',
  '  show <id> [--full]                      print one task, merging the archive for a stub.',
  '                                          Raw Jev answers only with --full',
  '  decide <id> --summary <text> [--ref <path>] [--by <owner>]',
  '                                          --ref and --by are trimmed; a blank value is refused.',
  '                                          A temp --ref file, or any local one on a gated task, is',
  '                                          copied beside the board before the lock.',
  '                                          --by jev is reserved for verdicts',
  '  ask-owner <id> <question...> --by <name> [--packet <packet.json>]',
  '                                          a worker or the lead asks the owner; the task must be',
  '                                          claimed, one question open at a time',
  '  answer <id> <answer...> --by <name>     the owner answers the open question',
  '                                          answer and note accept --expected <review-revision>',
  '  note <id> <note...> --by <name>         the owner queues a note to the lead. An open question goes',
  '                                          with it. A done or cancelled task reopens',
  "  note-read <id> --by <name>              the lead has read the owner's note",
  '  lead-reply <id> <reply...> --by <name>  the lead answers a handed question and closes the note',
  '  answer-read <id> --by <name>            the worker on the claim has read the answer',
  '  deliver [--task <id>] [--limit <n>]     send due outbox records. Default limit is 5.',
  '                                          Prints { sent, failed, nextDueAt }',
  '  inbox                                   owner threads waiting on the owner, the lead, or a worker.',
  "                                          done refuses while a task's thread is open; cancel refuses",
  "                                          while the owner's note is unread. Read-only",
  '  release <id> | cancel <id> | after <id> <id,id|none>',
  '  route <id> <route> [--reason <text>] [--by <owner>]',
  '                                          --reason is required to leave needs_lead, to override the',
  '                                          verdict, or to change a route a lead decision is holding,',
  '                                          including a return to the verdict route. --by jev is reserved',
  '  list [--all] [--status <s>] [--role <r>] [--tag <t>] [--json]',
  '                                          one line per task: id status role owner route after tag title.',
  '                                          --json prints the full tasks',
  '                                          default is open and claimed. --all expands the archive.',
  '                                          --status uses the full set, then filters. --tag filters too',
  '  archive --older-than-days <n>           append old done and cancelled tasks to',
  '                                          tasks.json.archive.jsonl and leave {id,status,archived} stubs',
  '  archive --id <id>                       archive one finished task now: the same rules, no age threshold',
  '  view [--role <r>] [--tag <t>] [--owner <o>] [--closed-limit <n>] [--closed-before <cursor>]',
  '                                          the whole board as the kanban renders it: open and claimed tasks,',
  '                                          one page of done and cancelled (archive merged), needsOwner,',
  '                                          withLead, the lead address, the file revision. Read-only',
  '  moves <id> [--by <name>]                per target (open, claimed, done, cancelled, clear): the command and',
  "                                          the inputs it needs, or the board's refusal. Read-only",
  '  stale [--hours <n>] [--runs]            claims with no sign of life (default 24h); read-only. --runs also asks T3',
  "                                          about each claim's wake thread and lists claims whose thread ended or is gone",
  '  reap --older-than <hours> [--role <r>] [--include-untimed]',
  '  doctor [--fix] [--runs]                 inspect the board and its files; --fix repairs what is provably broken;',
  '                                          --runs flags claims whose T3 wake thread ended or is gone (reads t3, 5s each)',
  '',
  'Decision policy (agent guidance, not automatic enforcement):',
  '  Resolve exact facts from instructions/source/checks first. For unresolved semantic judgment:',
  '  worker -> Jev -> coordinating lead -> human only if the lead needs a user decision/authority.',
  '  Use Node 22.18+: jev-route.ts for task routing; jev-decide.ts for implementation/fix options.',
  '  Use existing thresholds and one bounded live attempt when configured; keep input/result or error evidence.',
  '  A sound, confident, hold-free in-scope choice: decide <id> --summary <why> --ref <artifact> --by <actual-owner>.',
  '  Attach artifacts with evidence. Jev is not permission or test truth; verify assumptions and required checks.',
  '  Send needs_lead, holds/order flips, uncertainty, conflicts, missing scope/authority, or Jev failure to the lead.',
  '  Include one narrow question, input/result or unavailable evidence, options, recommendation, and blocker.',
  '  Children hand questions to the parent lead, not user-question UI tools; do not re-ask authorized work.',
  '  Only the lead resolves route holds with route <id> <route> --reason <why>; never impersonate --by jev.',
  '  No fabricated verdicts or endless retries. Instructions, safety, and tool-approval authority still apply.',
  '  Details and commands: skills/team-coordinator/references/jev-decisions.md',
].join('\n')

function takeFlag(args, name) {
  const at = args.indexOf(name)
  if (at === -1) return null
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  args.splice(at, 2)
  return value
}

function takeSwitch(args, name) {
  const at = args.indexOf(name)
  if (at === -1) return false
  args.splice(at, 1)
  return true
}

function toInt(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`)
  return number
}

function toIds(value, label) {
  if (value === 'none' || value === '') return []
  return value
    .split(',')
    .filter(Boolean)
    .map((id) => toInt(id, label))
}

function toHours(value, label) {
  const number = Number(value)
  if (!(number > 0)) throw new Error(`${label} must be a number of hours above zero, got ${JSON.stringify(value)}`)
  return number
}

function takeAllFlags(args, name) {
  const values = []
  for (;;) {
    const value = takeFlag(args, name)
    if (value === null) return values
    values.push(value)
  }
}

// The flags and switches each command reads. A separate argument shaped like a flag that is not listed is
// refused with the command's usage, so a wrong flag never reaches an item check or becomes part of a text.
const FLAGS = {
  add: ['--after', '--route', '--jev', '--reason', '--by', '--accept', '--git-proof', '--tag', '--review'],
  jev: [],
  claim: ['--id', '--run', '--wake'],
  heartbeat: ['--owner', '--run', '--wake'],
  'lead-wake': ['--task', '--tag', '--by', '--clear'],
  done: ['--owner', '--by', '--force', '--evidence'],
  evidence: ['--supporting'],
  'verify-git': ['--by'],
  judgment: [],
  'check-start': [],
  'check-end': [],
  'check-abandon': [],
  review: ['--by'],
  'review-report': [],
  accept: ['--reason', '--by'],
  show: ['--full'],
  decide: ['--summary', '--ref', '--by'],
  'ask-owner': ['--by', '--packet'],
  answer: ['--by', '--expected'],
  note: ['--by', '--expected'],
  'note-read': ['--by'],
  'lead-reply': ['--by'],
  'answer-read': ['--by'],
  deliver: ['--task', '--limit'],
  'deliver-retry': ['--by'],
  inbox: [],
  release: ['--by', '--reason'],
  cancel: ['--by', '--reason'],
  route: ['--reason', '--by'],
  after: [],
  list: ['--all', '--status', '--role', '--tag', '--json'],
  help: [],
  view: ['--role', '--tag', '--owner', '--closed-limit', '--closed-before'],
  moves: ['--by'],
  archive: ['--id', '--older-than-days'],
  stale: ['--hours', '--runs'],
  reap: ['--older-than', '--role', '--include-untimed'],
  doctor: ['--fix', '--runs'],
}

// "--by" and "--older-than-days" are flag-shaped; "--", "--By" and "use --force?" are not.
const FLAG_SHAPE = /^--[a-z][a-z-]*$/

function usageFor(command) {
  const names = new RegExp(`^(?:.*\\| )?${command}(?: |$)`)
  const lines = USAGE.split('\n').filter((line) => /^  \S/.test(line) && names.test(line.trim())).map((line) => line.trim())
  return lines.length ? `usage: ${lines.join('\n       ')}` : 'run team-tasks.mjs help for the full usage'
}

function refuseUnknownFlags(command, args) {
  if (!Object.hasOwn(FLAGS, command)) throw new Error(`${command} has no flag list in team-tasks.mjs FLAGS`)
  const unknown = args.find((arg) => FLAG_SHAPE.test(arg) && !FLAGS[command].includes(arg))
  if (unknown) throw new Error(`${command} takes no ${unknown}. ${usageFor(command)}`)
}

const out = (value) => console.log(JSON.stringify(value, null, 2))
const requireId = (args) => toInt(args[0], 'task id')

function boardNow() {
  const raw = process.env.TEAM_BOARD_NOW
  if (raw == null || raw === '') return new Date()
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw new Error('TEAM_BOARD_NOW must be an ISO time')
  return new Date(time)
}

const SEND_TIMEOUT_MS = 20_000
const RUNS_TIMEOUT_MS = 5_000

function boardT3Timeout(fallback) {
  const raw = process.env.TEAM_BOARD_T3_TIMEOUT_MS
  if (raw == null || raw === '') return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error('TEAM_BOARD_T3_TIMEOUT_MS must be a positive integer')
  return Number(raw)
}

function t3Binary() {
  const raw = process.env.TEAM_BOARD_T3_BIN
  if (raw != null && raw.trim()) return raw.trim()
  const installed = join(homedir(), '.t3', 'bin', 't3')
  return existsSync(installed) ? installed : 't3'
}

function t3Ids(type, reply, stdout) {
  const text = stdout.trim()
  if (!text) return {}
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  const parsed = reply(raw)
  if (parsed instanceof type.errors) return {}
  const ids = {}
  if (parsed.messageId) ids.messageId = parsed.messageId
  if (parsed.runId) ids.runId = parsed.runId
  return ids
}

// Runs the t3 binary once with a real timeout that kills the child. Never rejects: resolves to
// `{ok: true, stdout}` or `{ok: false, killed, errText, code}`. `input` goes to stdin when given.
function execT3(bin, args, timeoutMs, input) {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, stdout: String(stdout ?? '') })
          return
        }
        const code = typeof err.code === 'number' ? String(err.code) : String(err.code ?? err.signal ?? 'unknown')
        resolve({ ok: false, killed: Boolean(err.killed), errText: String(stderr ?? '').trim(), code })
      },
    )
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function sendOne(bin, job, timeoutMs) {
  const shared = { taskId: job.taskId, deliveryId: job.deliveryId, token: job.token, threadId: job.threadId }
  const result = await execT3(bin, ['thread', 'send', '--json', '--', job.threadId, '-'], timeoutMs, job.message)
  if (result.ok) return { ...shared, ok: true, stdout: result.stdout }
  const error = result.killed
    ? [`t3 thread send timed out after ${timeoutMs}ms`, result.errText].filter(Boolean).join('\n')
    : result.errText || `t3 thread send exited ${result.code}`
  return { ...shared, ok: false, error }
}

// T3 prints `Thread <id> is no longer available.` on stderr, exit 1, for an id it does not know (captured
// 2026-11-10). Match the whole line with this id: T3 ends other failures (a stale CLI credential, a removed
// provider) with "is no longer available." too, and reading those as missing would mark live claims dead.
const threadGone = (result, id) =>
  result.code === '1' && result.errText.split('\n').at(-1).trim() === `Thread ${id} is no longer available.`

// Reads one thread with `t3 thread show`. Resolves to a `runHealth` probe: the thread's state, `{missing: true}`
// when T3 says it does not exist, or `{error}` for anything else (no binary, timeout, odd output).
async function probeThread(bin, id, timeoutMs, readReply) {
  if (id.startsWith('-')) return { error: 'thread id looks like a flag' }
  const result = await execT3(bin, ['thread', 'show', id, '--json', '--messages', '0'], timeoutMs)
  if (!result.ok) {
    if (result.killed) return { error: `timed out after ${timeoutMs}ms` }
    if (threadGone(result, id)) return { missing: true }
    return { error: result.errText || `t3 exited ${result.code}` }
  }
  const reply = readReply(result.stdout)
  if (!reply) return { error: 'unreadable t3 output' }
  const { status, activeRunId, updatedAt } = reply.thread
  return { state: status, activeRunId: activeRunId ?? null, ...(updatedAt ? { updatedAt } : {}) }
}

// Asks T3 about every current wake thread on the board, one at a time. Read-only. Returns `{threadId: probe}`.
async function probeRuns(board) {
  const { type } = await import('arktype')
  const reply = type({ thread: { status: 'string', 'activeRunId?': 'string | null', 'updatedAt?': 'string' } })
  const readReply = (stdout) => {
    let raw
    try {
      raw = JSON.parse(stdout)
    } catch {
      return null
    }
    const parsed = reply(raw)
    return parsed instanceof type.errors ? null : parsed
  }
  const bin = t3Binary()
  const timeoutMs = boardT3Timeout(RUNS_TIMEOUT_MS)
  const probes = {}
  for (const id of runProbeTargets(board)) probes[id] = await probeThread(bin, id, timeoutMs, readReply)
  return probes
}

async function sendJobs(bin, jobs, timeoutMs, settle) {
  const { type } = await import('arktype')
  const reply = type({ 'messageId?': 'string', 'runId?': 'string' })
  for (const job of jobs) {
    const outcome = await sendOne(bin, job, timeoutMs)
    if (!outcome.ok) {
      settle(outcome)
      continue
    }
    settle({ ...outcome, ...t3Ids(type, reply, outcome.stdout) })
  }
}

// `mutate(board, items)` is the command's own write; it is rehearsed on the original paths before anything is copied.
function retained(file, id, items, mutate) {
  if (!items.length) return items
  const { stored, notes } = retainEvidence(file, id, items, (board) => mutate(board, items))
  for (const note of notes) console.error(`team-tasks: ${note}`)
  return stored
}

// The owner-thread commands take `<id> [text...] --by <name>`; the words after the id are the text.
function threadCommand(command) {
  return (file, args) => {
    const by = takeFlag(args, '--by')
    const expected = command === answerOwner || command === noteToLead ? takeFlag(args, '--expected') : null
    const packetFile = command === askOwner ? takeFlag(args, '--packet') : null
    const packet = packetFile ? parseReviewPacket(JSON.parse(readFileSync(packetFile, 'utf8'))) : undefined
    const id = requireId(args)
    const text = args.slice(1).join(' ')
    out(withBoard(file, (board) => command(board, id, { text, by, expected, packet })))
  }
}

// Each command takes the board file and its arguments (flags are removed from `args` as they are read).
const COMMANDS = {
  add(file, args) {
    const after = toIds(takeFlag(args, '--after') ?? '', '--after')
    const route = takeFlag(args, '--route')
    const jev = takeFlag(args, '--jev')
    const reason = takeFlag(args, '--reason')
    const by = takeFlag(args, '--by')
    const accept = takeFlag(args, '--accept')
    const proofFile = takeFlag(args, '--git-proof')
    const gitProof = proofFile ? JSON.parse(readFileSync(proofFile, 'utf8')) : null
    const tag = takeFlag(args, '--tag')
    const review = takeSwitch(args, '--review')
    const [role, ...title] = args
    const input = { role, title: title.join(' '), after, route, jev, reason, by, accept, gitProof, tag, review }
    out(withBoard(file, (board) => addTask(board, input)))
  },
  jev(file, args) {
    const id = requireId(args)
    const verdict = args[1]
    if (!verdict) throw new Error('usage: jev <id> <json>')
    out(withBoard(file, (board) => attachJev(board, id, verdict)))
  },
  claim(file, args) {
    const id = takeFlag(args, '--id')
    const run = takeFlag(args, '--run')
    const wake = takeFlag(args, '--wake')
    const [role, owner] = args
    if (!role || !owner) throw new Error('usage: claim <role> <owner> [--id <id>] [--run <kind>:<ref>]')
    const options = { id: id === null ? null : toInt(id, '--id'), run, wake }
    out(withBoard(file, (board) => claimTask(board, role, owner, options)))
  },
  heartbeat(file, args) {
    const owner = takeFlag(args, '--owner')
    const run = takeFlag(args, '--run')
    const wake = takeFlag(args, '--wake')
    out(withBoard(file, (board) => heartbeatTask(board, requireId(args), { owner, run, wake })))
  },
  'lead-wake'(file, args) {
    const id = takeFlag(args, '--task')
    const tag = takeFlag(args, '--tag')
    const by = takeFlag(args, '--by')
    const clear = takeSwitch(args, '--clear')
    if (id !== null && tag !== null) throw new Error('lead-wake takes --task or --tag, not both')
    if ((clear && args.length) || (!clear && args.length !== 1))
      throw new Error(
        'usage: lead-wake <threadId> [--task <id> | --tag <tag>] --by <name> or lead-wake --clear [--task <id> | --tag <tag>] --by <name>',
      )
    out(
      withBoard(file, (board) =>
        setLeadWake(board, args[0], { id: id === null ? null : toInt(id, '--task'), tag, by, clear }),
      ),
    )
  },
  done(file, args) {
    const owner = takeFlag(args, '--owner')
    const by = takeFlag(args, '--by')
    const force = takeSwitch(args, '--force')
    const evidence = takeAllFlags(args, '--evidence')
    const id = requireId(args)
    const done = (board, items) => doneTask(board, id, { owner, by, force, evidence: items })
    const stored = retained(file, id, evidence, done)
    out(withBoard(file, (board) => done(board, stored)))
  },
  evidence(file, args) {
    const supporting = takeSwitch(args, '--supporting')
    const id = requireId(args)
    const add = (board, items) => addEvidence(board, id, items, { supporting })
    const stored = retained(file, id, args.slice(1), add)
    out(withBoard(file, (board) => add(board, stored)))
  },
  'verify-git'(file, args) {
    const by = takeFlag(args, '--by')
    const id = requireId(args)
    if (args.length !== 1) throw new Error('usage: verify-git <id> --by <owner>')
    const verified = prepareGitProof(readBoard(file), id, by)
    out(withBoard(file, (board) => recordGitProof(board, id, verified)))
  },
  judgment(file, args) {
    const id = requireId(args)
    const raw = args[1]
    if (!raw) throw new Error('usage: judgment <id> <json>')
    out(withBoard(file, (board) => addJudgment(board, id, raw)))
  },
  async 'check-start'(file, args) {
    const id = requireId(args)
    const value = await parseCheckArgs(args[1], {
      by: 'string',
      token: 'string',
      evidence: 'string[]',
      basis: 'number.integer >= 0',
      'scope?': 'unknown',
    })
    out(withBoard(file, (board) => startEvidenceCheck(board, id, value)))
  },
  'check-end'(file, args) {
    const id = requireId(args)
    if (!args[1]) throw new Error('check-end needs a token')
    out(withBoard(file, (board) => endEvidenceCheck(board, id, args[1])))
  },
  async 'check-abandon'(file, args) {
    const id = requireId(args)
    const value = await parseCheckArgs(args[1], { by: 'string', token: 'string', basis: 'number.integer >= 0' })
    out(withBoard(file, (board) => abandonStaleEvidenceCheck(board, id, value)))
  },
  async review(file, args) {
    const by = takeFlag(args, '--by')
    const id = requireId(args)
    if (!args[1] || args.length !== 2) throw new Error('review <id> <file.json> --by <owner>')
    const { parseReview } = await import('./team-review.mjs')
    const review = parseReview(JSON.parse(readFileSync(args[1], 'utf8')))
    out(withBoard(file, (board) => recordReview(board, id, review, by)))
  },
  'review-report': (file, args) => out(reviewReport(showTask(file, requireId(args)))),
  accept(file, args) {
    const reason = takeFlag(args, '--reason')
    const by = takeFlag(args, '--by')
    out(withBoard(file, (board) => acceptEvidence(board, requireId(args), { reason, by })))
  },
  show(file, args) {
    const full = takeSwitch(args, '--full')
    const id = requireId(args)
    const task = showTask(file, id)
    if (full || !task.jev?.answers) return out(task)
    const { answers, ...jev } = task.jev
    out({ ...task, jev: { ...jev, answersOmitted: `show ${id} --full` } })
  },
  decide(file, args) {
    const summary = takeFlag(args, '--summary')
    const ref = takeFlag(args, '--ref')
    const by = takeFlag(args, '--by')
    const id = requireId(args)
    const decide = (board, refs) => decideTask(board, id, { summary, ref: refs[0] ?? null, by })
    const storedRef = ref == null ? [] : retained(file, id, [ref], decide)
    out(withBoard(file, (board) => decide(board, storedRef)))
  },
  'ask-owner': threadCommand(askOwner),
  answer: threadCommand(answerOwner),
  note: threadCommand(noteToLead),
  'note-read': threadCommand(readNote),
  'lead-reply': threadCommand(leadReply),
  'answer-read': threadCommand(readAnswer),
  async deliver(file, args) {
    const task = takeFlag(args, '--task')
    const limit = takeFlag(args, '--limit')
    if (args.length) throw new Error('usage: deliver [--task <id>] [--limit <n>]')
    const taskId = task === null ? null : toInt(task, '--task')
    const sweepLimit = limit === null ? DEFAULT_SWEEP_LIMIT : toInt(limit, '--limit')
    const now = boardNow()
    const timeoutMs = boardT3Timeout(SEND_TIMEOUT_MS)
    const prepared = withBoard(file, (board) =>
      prepareSweep(board, { taskId, limit: sweepLimit, now, scriptPath: boardScriptPath() }),
    )
    if (!prepared.jobs.length) {
      out({ sent: 0, failed: prepared.failed, nextDueAt: prepared.nextDueAt })
      return
    }
    let sent = 0
    let failed = prepared.failed
    let nextDueAt = prepared.nextDueAt
    await sendJobs(t3Binary(), prepared.jobs, timeoutMs, (outcome) => {
      const settled = withBoard(file, (board) => settleSweep(board, [outcome], boardNow()))
      sent += settled.sent
      failed += settled.failed
      nextDueAt = settled.nextDueAt
    })
    out({ sent, failed, nextDueAt })
  },
  'deliver-retry'(file, args) {
    const by = takeFlag(args, '--by')
    const id = requireId(args)
    if (args.length !== 2) throw new Error('usage: deliver-retry <id> <deliveryId> --by <name>')
    out(withBoard(file, (board) => retryDelivery(board, id, args[1], by, boardNow())))
  },
  inbox: (file) => out(ownerInbox(readBoard(file))),
  release(file, args) {
    const by = takeFlag(args, '--by')
    const reason = takeFlag(args, '--reason')
    out(withBoard(file, (board) => releaseTask(board, requireId(args), { by, reason })))
  },
  cancel(file, args) {
    const by = takeFlag(args, '--by')
    const reason = takeFlag(args, '--reason')
    out(withBoard(file, (board) => cancelTask(board, requireId(args), { by, reason })))
  },
  route(file, args) {
    const reason = takeFlag(args, '--reason')
    const by = takeFlag(args, '--by')
    if (args[1] === undefined) throw new Error('usage: route <id> <route> [--reason <text>] [--by <owner>]')
    out(withBoard(file, (board) => routeTask(board, requireId(args), args[1], { reason, by })))
  },
  after(file, args) {
    if (args[1] === undefined) throw new Error('usage: after <id> <id,id|none>')
    const after = toIds(args[1], 'dependency id')
    out(withBoard(file, (board) => setDependencies(board, requireId(args), after)))
  },
  list(file, args) {
    const all = takeSwitch(args, '--all')
    const status = takeFlag(args, '--status')
    const role = takeFlag(args, '--role')
    const tag = takeFlag(args, '--tag')
    const json = takeSwitch(args, '--json')
    const tasks = listBoard(file, { all, status, role, tag })
    if (json) return out(tasks)
    if (tasks.length) console.log(tasks.map(taskLine).join('\n'))
  },
  help(file, args) {
    if (args.length > 1) throw new Error('usage: help [<command>]')
    if (!args.length) return console.log(USAGE)
    if (!Object.hasOwn(COMMANDS, args[0])) throw new Error(`unknown command ${args[0]}. ${COMMAND_NAMES}`)
    console.log(usageFor(args[0]))
  },
  async view(file, args) {
    const role = takeFlag(args, '--role')
    const tag = takeFlag(args, '--tag')
    const owner = takeFlag(args, '--owner')
    const limit = takeFlag(args, '--closed-limit')
    const closedBefore = takeFlag(args, '--closed-before')
    if (args.length)
      throw new Error(
        'usage: view [--role <r>] [--tag <t>] [--owner <o>] [--closed-limit <n>] [--closed-before <cursor>]',
      )
    const { buildView, DEFAULT_CLOSED_LIMIT } = await import('./team-board-view.mjs')
    // The revision is read first: a write between the two reads makes it older than the content, so a client refetches.
    const stat = statSync(file)
    const board = readBoard(file)
    const archived = board.tasks.some((task) => task.archived === true) ? readArchiveMap(archivePath(file)) : new Map()
    out(
      buildView(board, {
        now: boardNow(),
        revision: `${stat.mtimeMs}-${stat.size}`,
        archived,
        role,
        tag,
        owner,
        closedLimit: limit === null ? DEFAULT_CLOSED_LIMIT : toInt(limit, '--closed-limit'),
        closedBefore,
      }),
    )
  },
  async moves(file, args) {
    const by = takeFlag(args, '--by')
    if (args.length !== 1) throw new Error('usage: moves <id> [--by <name>]')
    const { buildMoves } = await import('./team-board-view.mjs')
    out(buildMoves(readBoard(file), requireId(args), { by: by ?? undefined, now: boardNow() }))
  },
  archive(file, args) {
    const id = takeFlag(args, '--id')
    const raw = takeFlag(args, '--older-than-days')
    if (id !== null && raw !== null) throw new Error('archive takes --id or --older-than-days, not both')
    if (id === null && raw === null) throw new Error('archive needs --older-than-days <n> or --id <id>')
    const bytesBefore = existsSync(file) ? statSync(file).size : 0
    let run
    if (id !== null) {
      const taskId = toInt(id, '--id')
      run = (board) => archiveOne(board, archivePath(file), taskId)
    } else {
      const days = Number(raw)
      if (!Number.isFinite(days) || days <= 0)
        throw new Error(`--older-than-days must be a number of days above zero, got ${JSON.stringify(raw)}`)
      run = (board) => archiveTasks(board, archivePath(file), { days })
    }
    const { archived, tornBytesCut } = withBoard(file, run)
    if (tornBytesCut)
      console.error(`team-tasks: cut a torn last line (${tornBytesCut} bytes) from ${basename(archivePath(file))}`)
    const bytesAfter = existsSync(file) ? statSync(file).size : 0
    out({ archived, bytesBefore, bytesAfter, ...(tornBytesCut ? { tornBytesCut } : {}) })
  },
  async stale(file, args) {
    const hours = takeFlag(args, '--hours')
    const runs = takeSwitch(args, '--runs')
    const board = readBoard(file)
    const probes = runs ? await probeRuns(board) : null
    out(staleClaims(board, { hours: hours === null ? 24 : toHours(hours, '--hours'), probes }))
  },
  reap(file, args) {
    const olderThan = takeFlag(args, '--older-than')
    if (olderThan === null) throw new Error('reap needs --older-than <hours>; it is never run by default')
    const role = takeFlag(args, '--role')
    const includeUntimed = takeSwitch(args, '--include-untimed')
    const options = { hours: toHours(olderThan, '--older-than'), role, includeUntimed }
    out(withBoard(file, (board) => reapClaims(board, options)))
  },
  async doctor(file, args) {
    // Any mutating command also clears a dead lock, orphaned temp files and a corrupt board; --fix runs one on purpose.
    if (takeSwitch(args, '--fix')) withBoard(file, reopenOwnerlessClaims)
    const runs = takeSwitch(args, '--runs')
    const findings = inspectFiles(file)
    if (!findings.some((finding) => finding.code === 'unreadable-board')) {
      const board = readBoard(file)
      findings.push(...analyzeBoard(board))
      if (runs) findings.push(...runHealth(board, await probeRuns(board)))
    }
    const ok = !findings.some((finding) => finding.level === 'error')
    out({ ok, findings })
    if (!ok) process.exitCode = 1
  },
}

const COMMAND_NAMES = `commands: ${Object.keys(COMMANDS).join(', ')}
run team-tasks.mjs help <command> for one command's usage, or help for all of it`

function taskLine(task) {
  const after = task.after?.length ? ` after=${task.after.join(',')}` : ''
  const tag = task.tag ? ` tag=${task.tag}` : ''
  return `#${task.id} ${task.status} ${task.role} ${task.owner ?? '-'} ${task.route ?? '-'}${after}${tag} ${task.title}`
}

async function run(file, [command, ...args]) {
  const handler = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : null
  if (!handler) {
    console.error(`${command ? `unknown command ${command}. ` : ''}${COMMAND_NAMES}`)
    process.exitCode = 1
    return
  }
  refuseUnknownFlags(command, args)
  await handler(file, args)
}

try {
  await run(resolveBoardFile(), process.argv.slice(2))
} catch (error) {
  console.error(`team-tasks: ${error.message}`)
  process.exitCode = 1
} finally {
  for (const event of drainHealEvents()) console.error(`team-tasks: healed: ${event}`)
}
