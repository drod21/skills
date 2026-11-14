// Bounded exhaustive check of the owner thread on one task: a question to the owner, the owner's answer, and a
// note the owner queues to the lead (skills/verify-team-board/SKILL.md). It runs every order
// of the thread's commands, up to the budgets below, through the real functions in team-tasks.lib.mjs. The
// ghost is the agreed chart itself, moved by the commands that land and never read from the journal, and every
// reached board is compared with it. Read skills/verify-team-board/SKILL.md first.
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'
import { boardView } from './board-projection.mjs'

import {
  addTask,
  answerOwner,
  askOwner,
  cancelTask,
  claimTask,
  doneTask,
  leadReply,
  noteToLead,
  ownerThread,
  readAnswer,
  readNote,
  releaseTask,
} from './team-tasks.lib.mjs'

// Only a lead task may be added without an acceptance check, and the thread rules hold with or without one: the
// evidence gate is team-board-gate.test.ts.
const ROLE = 'lead'
const WORKERS = ['worker-a', 'worker-b'] as const
const LEAD = 'lead-l'
const OWNER = 'the-owner'
const START_MS = Date.UTC(2026, 0, 1)

type Task = { id: number; status: string; owner: string | null; decisions?: Record<string, unknown>[] }
type Board = { tasks: Task[] }

// The chart's regions. Work leaves out Silent and Rejected: they need a clock or a Jev check, and every guard
// that names them names Working too, so a claimed task stands for all three.
type Work = 'Queued' | 'Working' | 'Done' | 'Cancelled'
type Question = 'NoAsk' | 'Asked' | 'HandedToLead' | 'Answered'
type Note = 'NoNote' | 'NoteQueued' | 'NoteRead'
type Ghost = { work: Work; question: Question; note: Note }

// How many times each command may run on one path. The reads, the answer, and the reply need no budget: each
// one needs a question or a note that a budgeted command made.
type Budget = { claim: number; release: number; cancel: number; ask: number; note: number }
type World = { board: Board; ghost: Ghost; budget: Budget; clock: number }

type Action = {
  name: string
  budget?: keyof Budget
  run: (board: Board, id: number, now: Date) => void
  // The chart edge: when `allowed` holds the board must take the command (NotOverStrict), and `move` is where the
  // chart goes.
  allowed: (g: Ghost) => boolean
  move: (g: Ghost) => Ghost
}

type Violation = { rule: string; trace: string[] }

export const THREAD_BUDGET: Budget = { claim: 2, release: 1, cancel: 1, ask: 2, note: 2 }

const task = (board: Board) => board.tasks[0] as Task
const claimed = (g: Ghost) => g.work === 'Working'
const finished = (g: Ghost) => g.work === 'Done' || g.work === 'Cancelled'

// Two deliberate widenings of the chart, both looser for the owner and the lead and neither able to break a
// `never` rule: a second note re-queues (the chart has no note edge out of NoteQueued or NoteRead), and the
// lead's reply also counts as reading a note it had not marked read.
const ACTIONS: Action[] = [
  ...WORKERS.map<Action>((worker) => ({
    name: `${worker} claims the task`,
    budget: 'claim',
    run: (board, id, now) => void claimTask(board, ROLE, worker, { id, now }),
    allowed: (g) => g.work === 'Queued',
    move: (g) => ({ ...g, work: 'Working' }),
  })),
  {
    name: 'the worker releases the claim',
    budget: 'release',
    run: (board, id, now) => void releaseTask(board, id, { now }),
    allowed: claimed,
    move: (g) => ({ ...g, work: 'Queued' }),
  },
  {
    name: 'the worker asks the owner',
    budget: 'ask',
    run: (board, id, now) => void askOwner(board, id, { text: 'Which one?', by: task(board).owner, now }),
    allowed: (g) => claimed(g) && g.question === 'NoAsk',
    move: (g) => ({ ...g, question: 'Asked' }),
  },
  {
    name: 'the owner answers on the task',
    run: (board, id, now) => void answerOwner(board, id, { text: 'This one', by: OWNER, now }),
    allowed: (g) => g.question === 'Asked',
    move: (g) => ({ ...g, question: 'Answered' }),
  },
  {
    name: 'the owner queues a note to the lead',
    budget: 'note',
    run: (board, id, now) => void noteToLead(board, id, { text: 'Look at this', by: OWNER, now }),
    allowed: () => true,
    move: (g) => ({
      work: finished(g) ? 'Queued' : g.work,
      question: g.question === 'Asked' ? 'HandedToLead' : g.question,
      note: 'NoteQueued',
    }),
  },
  {
    name: 'the lead reads the note',
    run: (board, id, now) => void readNote(board, id, { by: LEAD, now }),
    allowed: (g) => g.note === 'NoteQueued',
    move: (g) => ({ ...g, note: 'NoteRead' }),
  },
  {
    name: 'the lead replies on the task',
    run: (board, id, now) => void leadReply(board, id, { text: 'Go ahead', by: LEAD, now }),
    allowed: (g) => g.question === 'HandedToLead' || g.note !== 'NoNote',
    move: (g) => ({ ...g, question: g.question === 'HandedToLead' ? 'Answered' : g.question, note: 'NoNote' }),
  },
  {
    name: 'the worker reads the answer',
    run: (board, id, now) => void readAnswer(board, id, { by: task(board).owner, now }),
    allowed: (g) => claimed(g) && g.question === 'Answered',
    move: (g) => ({ ...g, question: 'NoAsk' }),
  },
  {
    name: 'the lead cancels the task',
    budget: 'cancel',
    run: (board, id, now) => void cancelTask(board, id, { now }),
    allowed: (g) => g.work !== 'Done' && g.note !== 'NoteQueued',
    move: (g) => ({ ...g, work: 'Cancelled', question: 'NoAsk' }),
  },
  {
    name: 'the worker marks it done',
    run: (board, id, now) => void doneTask(board, id, { owner: task(board).owner, now }),
    allowed: (g) => claimed(g) && g.question === 'NoAsk' && g.note === 'NoNote',
    move: (g) => ({ ...g, work: 'Done' }),
  },
]

const WORK_OF: Record<string, Work> = { open: 'Queued', claimed: 'Working', done: 'Done', cancelled: 'Cancelled' }

// The chart's `never` rules, on the board the commands left. A landed command the chart has no edge for is
// reported too, so a rule cannot pass because the board took a step the chart forbids.
const NEVER: [string, (state: Ghost) => boolean][] = [
  ['DoneOverYourQuestion', (b) => b.work === 'Done' && b.question === 'Asked'],
  ['DoneOverUnreadAnswer', (b) => b.work === 'Done' && b.question === 'Answered'],
  ['DoneOverHandoff', (b) => b.work === 'Done' && b.question === 'HandedToLead'],
  ['DoneOverUnreadNote', (b) => b.work === 'Done' && b.note === 'NoteQueued'],
  // The chart's done guard is NoNote: a note the lead read and has not replied to also holds the work open.
  ['DoneOverUnrepliedNote', (b) => b.work === 'Done' && b.note === 'NoteRead'],
  ['CancelOverUnreadNote', (b) => b.work === 'Cancelled' && b.note === 'NoteQueued'],
]

function stateRules(board: Board, ghost: Ghost): string[] {
  const t = task(board)
  const read: Ghost = { work: WORK_OF[t.status] as Work, ...ownerThread(t) }
  const rules = NEVER.filter(([, breaks]) => breaks(read)).map(([rule]) => rule)
  const drift = read.work !== ghost.work || read.question !== ghost.question || read.note !== ghost.note
  return [...rules, ...(drift ? ['ThreadMatchesChart'] : []), ...dashboardRules(board, ghost), ...outboxProblems(board)]
}

type OutboxRecord = { entryKind?: string; entryAt?: string; audience?: { kind?: string } }

function messageAudience(kind: unknown, subject: { status: string; wake?: { threadId?: string } }) {
  if (kind === 'note' || subject.status !== 'claimed' || !subject.wake?.threadId) return 'lead'
  return 'claim'
}

function recordsFor(deliveries: OutboxRecord[], kind: unknown, at: unknown) {
  return deliveries.filter((record) => record.entryKind === kind && record.entryAt === at)
}

// This search never sets a wake address, so an answer's audience is the lead.
function outboxProblems(board: Board): string[] {
  const subject = task(board) as Task & { wake?: { threadId?: string }; deliveries?: OutboxRecord[] }
  const deliveries = subject.deliveries ?? []
  const entries = subject.decisions ?? []
  const messages = entries.filter(
    (entry, index) =>
      entry.kind === 'owner-answer' ||
      entry.kind === 'note' ||
      (entry.kind === 'lead-reply' &&
        ownerThread({ ...subject, decisions: entries.slice(0, index) }).question === 'HandedToLead'),
  )
  const missing = messages.some((entry) => {
    const records = recordsFor(deliveries, entry.kind, entry.at)
    const audience = entry.kind === 'lead-reply' ? 'claim' : messageAudience(entry.kind, subject)
    return records.length !== 1 || records[0]?.audience?.kind !== audience
  })
  const extra = deliveries.some(
    (record) => !messages.some((entry) => entry.kind === record.entryKind && entry.at === record.entryAt),
  )
  return missing || extra ? ['OutboxRecordPerAudience'] : []
}

// The command ghost grades the dashboard's independent journal fold too. Use one fixed live clock, as in the
// evidence-gate view check; this adds owner questions and lead notes without claiming clock/cache/HTTP coverage.
function dashboardRules(board: Board, ghost: Ghost): string[] {
  const view = boardView(board, START_MS + 10 * 60 * 60_000)
  const id = task(board).id
  const alert = view.gates.find((row) => row.id === id && row.gate.why === 'question')
  const lead = view.withLead.find((row) => row.id === id)
  const asked = ghost.question === 'Asked'
  const owed = ghost.question === 'HandedToLead' || ghost.note !== 'NoNote'
  const rows = [...view.gates, ...view.live, ...view.silent, ...view.waiting, ...view.done, ...view.withLead]
  const row = rows.find((row) => row.id === id)
  const thread = row?.thread ?? { question: 'NoAsk', note: 'NoNote' }
  return [
    ...(Boolean(alert) === asked ? [] : ['QuestionWithoutAlert']),
    ...(Boolean(lead) === owed ? [] : ['LeadInboxMatchesThread']),
    ...(thread.question === ghost.question && thread.note === ghost.note ? [] : ['DashboardThreadMatchesChart']),
  ]
}

function initialWorld(budget: Budget): World {
  const board: Board = { tasks: [] }
  addTask(board, { role: ROLE, title: 'Pick the label' })
  return { board, ghost: { work: 'Queued', question: 'NoAsk', note: 'NoNote' }, budget: { ...budget }, clock: 0 }
}

// Every path writes its own journal, so the key is what the board's answers depend on for this ungated task: its
// status and owner, the thread ownerThread reads from the journal, the ghost, and the budget left. Two boards with
// the same key take and refuse the same commands.
function stateKey(world: World) {
  const t = task(world.board)
  const json = JSON.stringify([t.status, t.owner, ownerThread(t), world.ghost, world.budget])
  return createHash('sha1').update(json).digest('base64')
}

// `null` means the board refused the command.
function step(world: World, action: Action): World | null {
  const next: World = structuredClone(world)
  const now = new Date(START_MS + (next.clock + 1) * 60_000)
  try {
    action.run(next.board, task(next.board).id, now)
  } catch {
    return null
  }
  if (action.budget) next.budget[action.budget] -= 1
  next.ghost = action.allowed(world.ghost) ? action.move(world.ghost) : world.ghost
  next.clock += 1
  return next
}

function brokenRules(world: World, action: Action, after: World | null): string[] {
  const allowed = action.allowed(world.ghost)
  if (!after) return allowed ? ['NotOverStrict'] : []
  // A command that lands and changes nothing (`done` on a done task) is no step.
  const moved = JSON.stringify(after.board) !== JSON.stringify(world.board)
  return [...(allowed || !moved ? [] : ['NeverOffChart']), ...stateRules(after.board, after.ghost)]
}

type Path = { name: string; previous: Path } | null
function steps(path: Path): string[] {
  const names: string[] = []
  for (let at = path; at; at = at.previous) names.unshift(at.name)
  return names
}

// Breadth first, so the first violation of each rule is its shortest path. A done task does not end a path
// here: a note can reopen it.
export function exploreThread(budget: Budget = THREAD_BUDGET) {
  const start = initialWorld(budget)
  const seen = new Set<string>([stateKey(start)])
  const violations = new Map<string, Violation>()
  const stats = { states: 0, transitions: 0 }
  let frontier: { world: World; path: Path }[] = [{ world: start, path: null }]
  while (frontier.length) {
    const next: typeof frontier = []
    for (const { world, path } of frontier) {
      stats.states += 1
      for (const action of ACTIONS) {
        if (action.budget && world.budget[action.budget] <= 0) continue
        const after = step(world, action)
        const reached: Path = { name: action.name, previous: path }
        for (const rule of brokenRules(world, action, after))
          if (!violations.has(rule)) violations.set(rule, { rule, trace: steps(reached) })
        if (!after) continue
        stats.transitions += 1
        const key = stateKey(after)
        if (seen.has(key)) continue
        seen.add(key)
        next.push({ world: after, path: reached })
      }
    }
    frontier = next
  }
  return { violations: [...violations.values()], stats }
}

const tell = (violation: Violation) =>
  `${violation.rule}:\n${violation.trace.map((line, index) => `  ${index + 1}. ${line}`).join('\n')}`

describe('the owner thread follows the agreed chart, every command order within the budgets', () => {
  it('never finishes or cancels over an open thread, and takes every step the chart allows', () => {
    const { violations, stats } = exploreThread()
    console.log(`thread: ${stats.states} states, ${stats.transitions} transitions`)
    expect(violations.map(tell)).toEqual([])
    expect(stats.states).toBeGreaterThan(100)
  })
})
