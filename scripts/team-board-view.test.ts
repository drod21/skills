// The kanban's read model. `view` and `moves` print the contract apps/board parses, so these tests drive the
// real CLI on temp boards and hold the move table to the commands that enforce it: a move `moves` calls legal
// must land, a refused one must be refused with the same words.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toJudgment } from './jev-ask.lib.ts'
import { boardView } from './board-projection.mjs'
import { reviewRevision } from './review-queue.mjs'
import { buildView, MOVE_TARGETS, VIEW_VERSION } from './team-board-view.mjs'
import {
  acceptEvidence,
  addEvidence,
  addJudgment,
  addTask,
  answerOwner,
  archiveOne,
  askOwner,
  cancelTask,
  claimTask,
  decideTask,
  doneTask,
  heartbeatTask,
  leadReply,
  noteToLead,
  readAnswer,
  readArchiveMap,
  readNote,
  releaseTask,
  setLeadWake,
} from './team-tasks.lib.mjs'

const CLI = join(import.meta.dirname, 'team-tasks.mjs')

type Json = Record<string, any>
type Board = { version: number; tasks: Json[]; leadWake?: Json }

let dir: string
let boardFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-view-'))
  boardFile = join(dir, 'tasks.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TEAM_TASKS_FILE: boardFile },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: (result.stdout.trim() ? JSON.parse(result.stdout) : undefined) as Json,
    error: result.stderr.split('\n')[0] ?? '',
  }
}

// A board built with the library's own functions, one minute apart from a fixed start.
const START = Date.UTC(2026, 10, 10, 12, 0, 0)
let minute = 0
const tick = () => new Date(START + ++minute * 60_000)
const freshBoard = (): Board => {
  minute = 0
  return { version: 1, tasks: [] }
}
const save = (board: Board) => writeFileSync(boardFile, `${JSON.stringify(board, null, 2)}\n`)
const task = (board: Board, id: number) => board.tasks.find((candidate) => candidate.id === id) as Json

function add(board: Board, fields: Json = {}) {
  return addTask(board, { role: 'lead', title: `Task ${board.tasks.length + 1}`, ...fields }).id as number
}
function claim(board: Board, id: number, owner = 'worker-a', wake?: string) {
  const role = task(board, id).role as string
  claimTask(board, role, owner, { id, now: tick(), wake: wake ?? null })
}

// ---------------------------------------------------------------- moves

type Expectation = `here` | `legal:${string}` | `refused:${string}`
type Scenario = {
  name: string
  build: (board: Board, archiveFile: string) => number
  expect: Record<(typeof MOVE_TARGETS)[number], Expectation>
  // What `release` would also send, from the claim's address and who releases it.
  notifies?: Record<string, string[]>
}

const GATED = { role: 'backend-worker', accept: 'the focused test passes' }

const SCENARIOS: Scenario[] = [
  {
    name: 'an open task',
    build: (board) => add(board),
    expect: {
      open: 'here',
      claimed: 'legal:note',
      done: 'refused:is open, not claimed',
      cancelled: 'legal:cancel',
      clear: 'legal:cancel',
    },
  },
  {
    name: 'a claimed task',
    build(board) {
      const id = add(board)
      claim(board, id)
      return id
    },
    expect: {
      open: 'legal:release',
      claimed: 'here',
      done: 'legal:done',
      cancelled: 'legal:cancel',
      clear: 'legal:cancel',
    },
  },
  {
    name: 'a claimed task with a wake address',
    build(board) {
      const id = add(board)
      claim(board, id, 'worker-a', 'thread:worker-a')
      return id
    },
    expect: {
      open: 'legal:release',
      claimed: 'here',
      done: 'legal:done',
      cancelled: 'legal:cancel',
      clear: 'legal:cancel',
    },
  },
  {
    name: 'a claimed gated task with no evidence',
    build(board) {
      const id = add(board, GATED)
      claim(board, id)
      return id
    },
    expect: {
      open: 'legal:release',
      claimed: 'here',
      done: 'refused:NeverDoneUnchecked',
      cancelled: 'legal:cancel',
      clear: 'legal:cancel',
    },
  },
  {
    name: 'a claimed task with an open question to the owner',
    build(board) {
      const id = add(board)
      claim(board, id)
      askOwner(board, id, { text: 'Which belt?', by: 'worker-a', now: tick() })
      return id
    },
    expect: {
      open: 'legal:release',
      claimed: 'here',
      done: 'refused:NeverDoneOverYourQuestion',
      cancelled: 'legal:cancel',
      clear: 'legal:cancel',
    },
  },
  {
    name: 'a claimed task with an unread note from the owner',
    build(board) {
      const id = add(board)
      claim(board, id)
      noteToLead(board, id, { text: 'Look again', by: 'owner', now: tick() })
      return id
    },
    expect: {
      open: 'legal:release',
      claimed: 'here',
      done: 'refused:NeverDoneOverNote',
      cancelled: 'refused:has an unread note from the owner',
      clear: 'refused:has an unread note from the owner',
    },
  },
  {
    name: 'a done task',
    build(board) {
      const id = add(board)
      claim(board, id)
      doneTask(board, id, { owner: 'worker-a', now: tick() })
      return id
    },
    expect: {
      open: 'legal:note',
      claimed: 'refused:it is done',
      done: 'here',
      cancelled: 'refused:a done task cannot be cancelled',
      clear: 'legal:archive',
    },
  },
  {
    name: 'a done task still over a question to the owner',
    build(board) {
      const id = add(board)
      claim(board, id)
      doneTask(board, id, { owner: 'worker-a', now: tick() })
      task(board, id).decisions = [{ kind: 'owner-ask', at: tick().toISOString(), by: 'worker-a', text: 'Late?' }]
      return id
    },
    expect: {
      open: 'legal:note',
      claimed: 'refused:it is done',
      done: 'here',
      cancelled: 'refused:a done task cannot be cancelled',
      clear: 'refused:was marked done without passing its checks',
    },
  },
  {
    name: 'a done task whose stop notice is still queued',
    build(board) {
      const id = add(board)
      claim(board, id, 'worker-a', 'thread:worker-a')
      doneTask(board, id, { by: 'lead-x', now: tick() })
      return id
    },
    expect: {
      open: 'legal:note',
      claimed: 'refused:it is done',
      done: 'here',
      cancelled: 'refused:a done task cannot be cancelled',
      clear: 'refused:not yet delivered',
    },
  },
  {
    name: 'a cancelled task',
    build(board) {
      const id = add(board)
      cancelTask(board, id, { by: 'owner', reason: 'Dead end', now: tick() })
      return id
    },
    expect: {
      open: 'legal:note',
      claimed: 'refused:it is cancelled',
      done: 'refused:is cancelled, not claimed',
      cancelled: 'here',
      clear: 'legal:archive',
    },
  },
  {
    name: 'a cancelled task whose stop notice is still queued',
    build(board) {
      const id = add(board)
      claim(board, id, 'worker-a', 'thread:worker-a')
      cancelTask(board, id, { by: 'lead-x', reason: 'Dead end', now: tick() })
      return id
    },
    expect: {
      open: 'legal:note',
      claimed: 'refused:it is cancelled',
      done: 'refused:is cancelled, not claimed',
      cancelled: 'here',
      clear: 'refused:not yet delivered',
    },
  },
  {
    name: 'an archived done task',
    build(board, archiveFile) {
      const id = add(board)
      claim(board, id)
      doneTask(board, id, { owner: 'worker-a', now: tick() })
      archiveOne(board, archiveFile, id)
      return id
    },
    expect: {
      open: 'refused:is archived',
      claimed: 'refused:is archived',
      done: 'here',
      cancelled: 'refused:is archived',
      clear: 'refused:already archived',
    },
  },
]

type Move = {
  state: 'here' | 'legal' | 'refused'
  command?: string
  args?: string[]
  inputs?: { name: string; flag: string | null; required: boolean; prefill: string | null }[]
  lands?: string
  notifies?: string[]
  reason?: string
}

// The argv a caller builds from a move: its fixed args, then each text input after the id, then each flag input.
function argvOf(move: Move) {
  const filled = (move.inputs ?? []).map((input) => ({ ...input, value: input.prefill ?? 'Moved from the kanban' }))
  return [
    ...(move.args ?? []),
    ...filled.filter((input) => !input.flag).map((input) => input.value),
    ...filled.filter((input) => input.flag).flatMap((input) => [input.flag as string, input.value]),
  ]
}

describe('moves', () => {
  it.each(SCENARIOS)('$name: every target is the real command or its refusal', (scenario) => {
    const board = freshBoard()
    const archiveFile = `${boardFile}.archive.jsonl`
    const id = scenario.build(board, archiveFile)
    save(board)
    const baseline = readFileSync(boardFile, 'utf8')
    const archiveBaseline = existsSync(archiveFile) ? readFileSync(archiveFile, 'utf8') : null
    const restore = () => {
      writeFileSync(boardFile, baseline)
      if (archiveBaseline === null) rmSync(archiveFile, { force: true })
      else writeFileSync(archiveFile, archiveBaseline)
    }

    const asked = cli('moves', String(id), '--by', 'owner')
    expect(asked.status, asked.stderr).toBe(0)
    expect(readFileSync(boardFile, 'utf8')).toBe(baseline)
    expect(asked.json).toMatchObject({ version: VIEW_VERSION, id, by: 'owner' })
    expect(Object.keys(asked.json.targets)).toEqual([...MOVE_TARGETS])

    for (const target of MOVE_TARGETS) {
      const move = asked.json.targets[target] as Move
      const [state, detail] = scenario.expect[target].split(/:(.*)/s)
      expect(move.state, `${target}`).toBe(state)
      if (state === 'here') {
        expect(target).toBe(asked.json.status)
        continue
      }
      expect(move.command, `${target} command`).toBeDefined()
      restore()
      const ran = cli(...argvOf(move))
      if (state === 'legal') {
        expect(move.command, `${target} command`).toBe(detail)
        expect(ran.status, `${target}: ${ran.stderr}`).toBe(0)
        const after = JSON.parse(readFileSync(boardFile, 'utf8')) as Board
        const landed = task(after, id)
        if (move.lands === 'archived') expect(landed).toEqual({ id, status: asked.json.status, archived: true })
        else expect(landed.status, `${target} lands`).toBe(move.lands)
        expect(Object.keys(move)).not.toContain('reason')
      } else {
        expect(ran.status, `${target} should be refused`).toBe(1)
        expect(ran.error, `${target} reason`).toBe(`team-tasks: ${move.reason}`)
        expect(move.reason, `${target} reason`).toContain(detail)
        expect(readFileSync(boardFile, 'utf8')).toBe(baseline)
      }
    }
  })

  it('names who is told: a stop notice goes out only for a claim with an address that someone else ends', () => {
    const board = freshBoard()
    const id = add(board)
    claim(board, id, 'worker-a', 'thread:worker-a')
    save(board)
    const byOwner = cli('moves', String(id), '--by', 'owner').json.targets
    expect(byOwner.open.notifies).toEqual(['ended-claim'])
    expect(byOwner.done.notifies).toEqual(['ended-claim'])
    expect(byOwner.cancelled.notifies).toEqual(['ended-claim'])
    const byWorker = cli('moves', String(id), '--by', 'worker-a').json.targets
    expect(byWorker.open.notifies).toEqual([])
    expect(byWorker.done.notifies).toEqual([])
    const open = freshBoard()
    const openId = add(open)
    save(open)
    expect(cli('moves', String(openId)).json).toMatchObject({ by: 'owner' })
  })

  it('prefills the start note, carries the review revision, and asks for the text that reopens finished work', () => {
    const board = freshBoard()
    const openId = add(board)
    const doneId = add(board)
    claim(board, doneId)
    doneTask(board, doneId, { owner: 'worker-a', now: tick() })
    save(board)
    const start = cli('moves', String(openId), '--by', 'owner').json.targets.claimed as Move
    expect(start.args).toEqual([
      'note',
      String(openId),
      '--by',
      'owner',
      '--expected',
      reviewRevision(task(board, openId)),
    ])
    expect(start.inputs).toEqual([{ name: 'text', flag: null, required: true, prefill: `Please start task ${openId}` }])
    expect(start.lands).toBe('open')
    expect(start.notifies).toEqual(['lead'])
    const reopen = cli('moves', String(doneId), '--by', 'owner').json.targets.open as Move
    expect(reopen.inputs).toEqual([{ name: 'text', flag: null, required: true, prefill: null }])
    const cancel = cli('moves', String(openId), '--by', 'owner').json.targets.cancelled as Move
    expect(cancel.inputs).toEqual([{ name: 'reason', flag: '--reason', required: true, prefill: null }])
    const release = cli('moves', String(openId), '--by', 'owner').json.targets.open as Move
    expect(release.state).toBe('here')
  })

  it('refuses an unknown task and offers no force', () => {
    save(freshBoard())
    const missing = cli('moves', '9')
    expect(missing.status).toBe(1)
    expect(missing.error).toBe('team-tasks: task 9 does not exist')
    const board = freshBoard()
    const id = add(board)
    save(board)
    const targets = Object.values(cli('moves', String(id)).json.targets) as Move[]
    expect(targets.flatMap((move) => move.args ?? [])).not.toContain('--force')
  })

  it('reads the board without writing it', () => {
    const board = freshBoard()
    const id = add(board)
    save(board)
    const before = statSync(boardFile).mtimeMs
    cli('moves', String(id))
    expect(statSync(boardFile).mtimeMs).toBe(before)
    expect(existsSync(`${boardFile}.bak`)).toBe(false)
    expect(existsSync(`${boardFile}.lock`)).toBe(false)
  })
})

// ---------------------------------------------------------------- archive --id

describe('archive --id', () => {
  it('archives one finished task now and leaves every other task alone', () => {
    const board = freshBoard()
    const first = add(board)
    const second = add(board)
    claim(board, first)
    doneTask(board, first, { owner: 'worker-a', now: tick() })
    claim(board, second)
    doneTask(board, second, { owner: 'worker-a', now: tick() })
    save(board)
    const result = cli('archive', '--id', String(first))
    expect(result.status, result.stderr).toBe(0)
    expect(result.json).toMatchObject({ archived: 1 })
    const saved = JSON.parse(readFileSync(boardFile, 'utf8')) as Board
    expect(task(saved, first)).toEqual({ id: first, status: 'done', archived: true })
    expect(task(saved, second).title).toBe('Task 2')
    const lines = readFileSync(`${boardFile}.archive.jsonl`, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: first, title: 'Task 1', status: 'done' })
    expect(cli('show', String(first)).json).toMatchObject({ title: 'Task 1', archived: true })
  })

  it('refuses a task that is not finished, in the words moves reports', () => {
    const board = freshBoard()
    const id = add(board)
    save(board)
    const refused = cli('archive', '--id', String(id))
    expect(refused.status).toBe(1)
    expect(refused.error).toBe(`team-tasks: task ${id} is open; only a done or cancelled task can be archived`)
    expect(JSON.parse(readFileSync(boardFile, 'utf8')).tasks[0].archived).toBeUndefined()
  })

  it('does not combine with --older-than-days and needs one of them', () => {
    save(freshBoard())
    expect(cli('archive', '--id', '1', '--older-than-days', '7').status).toBe(1)
    expect(cli('archive').error).toContain('archive needs')
    expect(cli('archive', '--id', 'x').error).toContain('--id must be a positive integer')
  })
})

// ---------------------------------------------------------------- view

const NOW = new Date(START + 2 * 3_600_000)

function view(board: Board, options: Json = {}) {
  return buildView(board, { now: NOW, revision: 'rev', archived: new Map(), ...options }) as Json
}

describe('view', () => {
  it('prints the versioned projection with the file revision and the lead address', () => {
    const board = freshBoard()
    setLeadWake(board, 'thread:lead', { by: 'lead', now: tick() })
    add(board)
    save(board)
    const result = cli('view')
    expect(result.status, result.stderr).toBe(0)
    const stat = statSync(boardFile)
    expect(result.json).toMatchObject({
      version: VIEW_VERSION,
      revision: `${stat.mtimeMs}-${stat.size}`,
      lead: { threadId: 'thread:lead', by: 'lead' },
      counts: { open: 1, claimed: 0, done: 0, cancelled: 0, archived: 0 },
      closed: { limit: 50, tasks: [], next: null },
      needsOwner: [],
      withLead: [],
    })
    expect(result.json.tasks.map((card: Json) => card.id)).toEqual([1])
    expect(readFileSync(boardFile, 'utf8')).toBe(`${JSON.stringify(board, null, 2)}\n`)
    expect(existsSync(`${boardFile}.lock`)).toBe(false)
  })

  it('shows every open and claimed task with the board’s own state for it', () => {
    const board = freshBoard()
    const gated = add(board, { ...GATED, tag: 'board-kanban' })
    const waiting = add(board, { after: [gated] })
    const stale = add(board)
    claim(board, gated, 'worker-a', 'thread:worker-a')
    heartbeatTask(board, gated, { owner: 'worker-a', now: tick(), run: 'session:abc' })
    claim(board, stale)
    task(board, stale).claimedAt = new Date(NOW.getTime() - 30 * 3_600_000).toISOString()
    askOwner(board, gated, { text: 'Which belt?', by: 'worker-a', now: tick() })
    const result = view(board)
    const cards = Object.fromEntries(result.tasks.map((card: Json) => [card.id, card]))
    expect(Object.keys(cards).map(Number)).toEqual([gated, waiting, stale])
    expect(cards[gated]).toMatchObject({
      status: 'claimed',
      owner: 'worker-a',
      role: 'backend-worker',
      tag: 'board-kanban',
      gated: true,
      wake: { threadId: 'thread:worker-a', at: task(board, gated).claimedAt },
      run: { kind: 'session', ref: 'abc' },
      ownerThread: { question: 'Asked', note: 'NoNote' },
      silent: false,
      reviewRevision: reviewRevision(task(board, gated)),
    })
    expect(cards[gated].lastSignalAt).toBe(task(board, gated).heartbeatAt)
    expect(cards[gated].doneBlockers.join(' ')).toContain('NeverDoneUnchecked')
    expect(cards[gated].doneBlockers.join(' ')).toContain('NeverDoneOverYourQuestion')
    expect(cards[waiting]).toMatchObject({
      status: 'open',
      owner: null,
      wake: null,
      waitsOn: [{ id: gated, status: 'claimed' }],
    })
    expect(cards[stale]).toMatchObject({ silent: true, wake: null })
    expect(cards[gated].silent).toBe(false)
  })

  it('drops a stale wake address and a done blocker list reads the same rules as done', () => {
    const board = freshBoard()
    const id = add(board)
    claim(board, id, 'worker-a', 'thread:worker-a')
    task(board, id).wake.at = '2020-01-01T00:00:00.000Z'
    expect(view(board).tasks[0].wake).toBeNull()
  })

  it('filters by role, tag and claim owner in every list', () => {
    const board = freshBoard()
    const lead = add(board, { tag: 'a' })
    const worker = add(board, { ...GATED, tag: 'b' })
    claim(board, worker, 'worker-b')
    claim(board, lead, 'worker-a')
    doneTask(board, lead, { owner: 'worker-a', now: tick() })
    expect(view(board, { role: 'backend-worker' }).tasks.map((card: Json) => card.id)).toEqual([worker])
    expect(view(board, { tag: 'a' }).tasks).toEqual([])
    expect(view(board, { tag: 'a' }).closed.tasks.map((card: Json) => card.id)).toEqual([lead])
    expect(view(board, { owner: 'worker-b' }).tasks.map((card: Json) => card.id)).toEqual([worker])
    expect(view(board, { owner: 'worker-b' }).closed.tasks).toEqual([])
    expect(view(board, { role: 'lead' }).counts).toMatchObject({ claimed: 1, done: 1 })
  })

  it('puts the delivery state of each outbox record under the message it carries', () => {
    const board = freshBoard()
    setLeadWake(board, 'thread:lead', { by: 'lead', now: tick() })
    const id = add(board)
    claim(board, id, 'worker-a', 'thread:worker-a')
    askOwner(board, id, { text: 'Which belt?', by: 'worker-a', now: tick() })
    answerOwner(board, id, { text: 'Use the belt', by: 'owner', now: tick() })
    noteToLead(board, id, { text: 'Also this', by: 'owner', now: tick() })
    const records = task(board, id).deliveries as Json[]
    expect(records.map((record) => record.state)).toEqual(['pending', 'pending', 'pending'])
    records[0] = {
      ...records[0],
      state: 'delivered',
      deliveredAt: '2026-11-10T12:30:00.000Z',
      threadId: 'thread:worker-a',
      t3: { messageId: 'm1' },
    }
    delete records[0].nextAttemptAt
    records[1] = {
      ...records[1],
      state: 'failed',
      failedAt: '2026-11-10T12:31:00.000Z',
      threadId: 'thread:lead',
      error: 'boom',
    }
    delete records[1].nextAttemptAt
    records[2] = {
      ...records[2],
      state: 'sending',
      leaseUntil: '2026-11-10T12:40:00.000Z',
      token: 'secret-token',
      threadId: 'thread:worker-a',
    }
    delete records[2].nextAttemptAt
    const card = view(board).tasks[0]
    const messages = Object.fromEntries(card.messages.map((message: Json) => [message.kind, message]))
    expect(card.messages.map((message: Json) => message.kind)).toEqual(['owner-ask', 'owner-answer', 'note'])
    expect(messages['owner-ask']).toMatchObject({ by: 'worker-a', text: 'Which belt?', deliveries: [] })
    expect(messages['owner-answer'].deliveries).toEqual([
      {
        id: records[0].id,
        entryKind: 'owner-answer',
        entryAt: messages['owner-answer'].at,
        audience: { kind: 'claim' },
        attempts: 0,
        state: 'delivered',
        deliveredAt: '2026-11-10T12:30:00.000Z',
        threadId: 'thread:worker-a',
        t3: { messageId: 'm1' },
      },
    ])
    expect(messages.note.deliveries.map((record: Json) => [record.audience.kind, record.state])).toEqual([
      ['lead', 'failed'],
      ['claim', 'sending'],
    ])
    expect(messages.note.deliveries[0]).toMatchObject({ failedAt: '2026-11-10T12:31:00.000Z', error: 'boom' })
    expect(JSON.stringify(card)).not.toContain('secret-token')
    expect(card.deliveries).toHaveLength(3)
    expect(card.undelivered).toBe(2)
  })

  it('reports a message with no address as unaddressed', () => {
    const board = freshBoard()
    const id = add(board)
    noteToLead(board, id, { text: 'Hello', by: 'owner', now: tick() })
    expect(view(board).tasks[0].messages[0].deliveries[0]).toMatchObject({
      state: 'unaddressed',
      reason: 'the board has no lead address',
    })
  })
})

// ---------------------------------------------------------------- closed page

describe('view closed page', () => {
  function finished(board: Board, archiveFile: string) {
    // Close times: ids 1 and 2 tie, id 3 is a cancel, id 4 is archived, id 5 is old, id 6 has no doneAt.
    const times = {
      1: '2026-11-09T10:00:00.000Z',
      2: '2026-11-09T10:00:00.000Z',
      3: '2026-11-09T11:00:00.000Z',
      4: '2026-11-09T09:00:00.000Z',
      5: '2026-10-01T09:00:00.000Z',
      7: '2026-11-09T12:00:00.000Z',
    } as const
    for (let n = 1; n <= 7; n += 1) add(board, { title: `Finished ${n}` })
    for (const id of [1, 2, 4, 5, 7]) {
      claim(board, id)
      doneTask(board, id, { owner: 'worker-a', now: tick() })
      task(board, id).doneAt = times[id as keyof typeof times]
    }
    cancelTask(board, 3, { by: 'owner', reason: 'Dead end', now: tick() })
    task(board, 3).decisions.at(-1).at = times[3]
    claim(board, 6)
    doneTask(board, 6, { owner: 'worker-a', now: tick() })
    delete task(board, 6).doneAt
    archiveOne(board, archiveFile, 4)
    archiveOne(board, archiveFile, 5)
    return [7, 3, 2, 1, 4, 5, 6]
  }

  it('pages by close time then id, newest first, with every archived task merged in exactly once', () => {
    const board = freshBoard()
    const archiveFile = join(dir, 'tasks.json.archive.jsonl')
    const expected = finished(board, archiveFile)
    const archived = readArchiveMap(archiveFile)
    const seen: number[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 10; pages += 1) {
      const page = view(board, { archived, closedLimit: 3, closedBefore: cursor }).closed
      expect(page.limit).toBe(3)
      expect(page.tasks.length).toBeLessThanOrEqual(3)
      seen.push(...page.tasks.map((card: Json) => card.id))
      if (page.next === null) break
      expect(page.tasks).toHaveLength(3)
      cursor = page.next
    }
    expect(seen).toEqual(expected)
    const whole = view(board, { archived, closedLimit: 50 }).closed
    expect(whole.tasks.map((card: Json) => card.id)).toEqual(expected)
    expect(whole.next).toBeNull()
    const cards = Object.fromEntries(whole.tasks.map((card: Json) => [card.id, card]))
    expect(cards[4]).toMatchObject({
      archived: true,
      title: 'Finished 4',
      status: 'done',
      closedAt: '2026-11-09T09:00:00.000Z',
    })
    expect(cards[3]).toMatchObject({ status: 'cancelled', closedAt: '2026-11-09T11:00:00.000Z' })
    expect(cards[6].closedAt).toBeNull()
    expect(view(board, { archived }).counts).toMatchObject({ done: 6, cancelled: 1, archived: 2 })
  })

  it('rejects a cursor it did not issue, and a stub with no archive line still pages', () => {
    const board = freshBoard()
    const archiveFile = join(dir, 'tasks.json.archive.jsonl')
    finished(board, archiveFile)
    save(board)
    expect(() => view(board, { closedBefore: 'yesterday' })).toThrow(
      '--closed-before must be a cursor from a previous view',
    )
    expect(view(board, { archived: new Map() }).closed.tasks.map((card: Json) => card.id)).toContain(4)
    expect(cli('view', '--closed-before', 'yesterday').error).toContain('--closed-before must be a cursor')
    expect(cli('view', '--closed-limit', '0').error).toContain('--closed-limit must be a positive integer')
  })

  it('reads the archive file and pages through the CLI', () => {
    const board = freshBoard()
    const archiveFile = `${boardFile}.archive.jsonl`
    const expected = finished(board, archiveFile)
    save(board)
    const first = cli('view', '--closed-limit', '4').json.closed
    expect(first.tasks.map((card: Json) => card.id)).toEqual(expected.slice(0, 4))
    const second = cli('view', '--closed-limit', '4', '--closed-before', first.next).json.closed
    expect(second.tasks.map((card: Json) => card.id)).toEqual(expected.slice(4))
    expect(second.next).toBeNull()
  })
})

// ---------------------------------------------------------------- needsOwner and withLead

describe('view needsOwner and withLead', () => {
  const reasons = (board: Board, id: number) =>
    (view(board).needsOwner.find((row: Json) => row.id === id)?.reasons ?? []) as Json[]

  it('lists an open question, a held check the owner can accept, a rejection and an ask hold', () => {
    const board = freshBoard()
    const question = add(board, GATED)
    const heldCheck = add(board, GATED)
    const rejected = add(board, GATED)
    const heldAsk = add(board, GATED)
    for (const id of [question, heldCheck, rejected, heldAsk]) claim(board, id)
    askOwner(board, question, { text: 'Which belt?', by: 'worker-a', now: tick() })
    for (const [id, outcome] of [
      [heldCheck, 'hold'],
      [rejected, 'rejected'],
    ] as const) {
      addEvidence(board, id, [`${id}.log`])
      addJudgment(board, id, checkJudgment(board, id, outcome), { now: tick() })
    }
    addJudgment(
      board,
      heldAsk,
      JSON.stringify(
        toJudgment(
          'ask',
          { outcome: 'hold', answer: null, p: 0.9, confidence: 0.9, reasons: [] },
          judgmentMeta('ask', 'worker-a'),
        ),
      ),
      { now: tick() },
    )
    expect(reasons(board, question)).toEqual([
      expect.objectContaining({ why: 'question', text: 'Which belt?', by: 'worker-a' }),
    ])
    expect(reasons(board, heldCheck)).toEqual([
      expect.objectContaining({ why: 'hold', tool: 'check', canAccept: true }),
    ])
    expect(reasons(board, rejected)).toEqual([expect.objectContaining({ why: 'rejected', tool: 'check' })])
    expect(reasons(board, heldAsk)).toEqual([expect.objectContaining({ why: 'hold', tool: 'ask', canAccept: false })])
    expect(view(board).needsOwner.map((row: Json) => row.id)).toEqual([question, heldCheck, rejected, heldAsk])
  })

  it('lists a failed or unaddressed delivery, even on a finished task', () => {
    const board = freshBoard()
    const id = add(board)
    noteToLead(board, id, { text: 'Hello', by: 'owner', now: tick() })
    leadReply(board, id, { text: 'Seen', by: 'lead', now: tick() })
    expect(reasons(board, id)).toEqual([expect.objectContaining({ why: 'delivery', state: 'unaddressed' })])
    const record = task(board, id).deliveries[0]
    Object.assign(record, {
      state: 'failed',
      failedAt: '2026-11-10T12:31:00.000Z',
      threadId: 'thread:lead',
      error: 'boom',
    })
    delete record.since
    delete record.reason
    expect(reasons(board, id)).toEqual([expect.objectContaining({ why: 'delivery', state: 'failed', detail: 'boom' })])
    cancelTask(board, id, { by: 'owner', reason: 'Done here', now: tick() })
    expect(reasons(board, id).map((reason) => reason.why)).toEqual(['delivery'])
  })

  it('lists what the owner handed to the lead and the lead has not answered', () => {
    const board = freshBoard()
    const id = add(board)
    claim(board, id)
    askOwner(board, id, { text: 'Which belt?', by: 'worker-a', now: tick() })
    noteToLead(board, id, { text: 'Lead, decide', by: 'owner', now: tick() })
    const row = view(board).withLead.find((candidate: Json) => candidate.id === id)
    expect(row).toMatchObject({ question: 'HandedToLead', note: 'NoteQueued', text: 'Lead, decide' })
    readNote(board, id, { by: 'lead', now: tick() })
    expect(view(board).withLead[0]).toMatchObject({ note: 'NoteRead' })
    leadReply(board, id, { text: 'Use the belt', by: 'lead', now: tick() })
    expect(view(board).withLead).toEqual([])
  })
})

// ---------------------------------------------------------------- parity with the dashboard

// The dashboard projection re-derives the owner gate from the journal (scripts/board-projection.mjs), and
// scripts/team-board-gate.test.ts holds that copy to the library. `needsOwner` is the same list built from the
// library's own rules, so every board a bounded search reaches must show both lists the same.
const JUDGMENT_HASH = '0'.repeat(64)
const judgmentMeta = (tool: string, by: string) => ({
  by,
  question: `${tool} question`,
  requestHash: JUDGMENT_HASH,
  receipt: `/receipts/${tool}.json`,
})

function checkJudgment(board: Board, id: number, outcome: 'confirmed' | 'rejected' | 'hold') {
  const current = task(board, id)
  const result = { outcome, gap: null, p: 0.9, reasons: [] }
  return JSON.stringify(
    toJudgment(
      'check',
      result as never,
      {
        ...judgmentMeta('check', current.owner),
        evidence: current.evidence,
        basis: (current.decisions ?? []).length,
      } as never,
    ),
  )
}

type Step = { name: string; run: (board: Board, now: Date) => void }

const STEPS: Step[] = [
  { name: 'claim', run: (board, now) => void claimTask(board, 'backend-worker', 'worker-a', { id: 1, now }) },
  { name: 'release', run: (board, now) => void releaseTask(board, 1, { now }) },
  { name: 'evidence', run: (board) => void addEvidence(board, 1, ['e1.log']) },
  ...(['confirmed', 'rejected', 'hold'] as const).map<Step>((outcome) => ({
    name: `check ${outcome}`,
    run: (board, now) => void addJudgment(board, 1, checkJudgment(board, 1, outcome), { now }),
  })),
  ...(['ask', 'decide'] as const).flatMap<Step>((tool) =>
    (['answered', 'hold'] as const).map<Step>((outcome) => ({
      name: `${tool} ${outcome}`,
      run(board, now) {
        const answer = outcome === 'answered' ? 'yes' : null
        const result = { outcome, answer, p: 0.9, confidence: 0.9, reasons: [] }
        addJudgment(board, 1, JSON.stringify(toJudgment(tool, result as never, judgmentMeta(tool, 'worker-a'))), {
          now,
        })
      },
    })),
  ),
  { name: 'choice', run: (board, now) => void decideTask(board, 1, { summary: 'Keep going', by: 'lead-l', now }) },
  { name: 'accept', run: (board, now) => void acceptEvidence(board, 1, { reason: 'Read it', by: 'lead-l', now }) },
  { name: 'ask-owner', run: (board, now) => void askOwner(board, 1, { text: 'Q?', by: 'worker-a', now }) },
  { name: 'answer', run: (board, now) => void answerOwner(board, 1, { text: 'A', by: 'owner', now }) },
  { name: 'note', run: (board, now) => void noteToLead(board, 1, { text: 'N', by: 'owner', now }) },
  { name: 'note-read', run: (board, now) => void readNote(board, 1, { by: 'lead-l', now }) },
  { name: 'lead-reply', run: (board, now) => void leadReply(board, 1, { text: 'R', by: 'lead-l', now }) },
  { name: 'answer-read', run: (board, now) => void readAnswer(board, 1, { by: 'worker-a', now }) },
  { name: 'cancel', run: (board, now) => void cancelTask(board, 1, { by: 'owner', now }) },
  { name: 'done', run: (board, now) => void doneTask(board, 1, { owner: 'worker-a', now }) },
]

const TIME_FIELDS = new Set([
  'at',
  'claimedAt',
  'heartbeatAt',
  'doneAt',
  'createdAt',
  'entryAt',
  'nextAttemptAt',
  'since',
])
const stateKey = (board: Board) =>
  createHash('sha1')
    .update(JSON.stringify(board, (key, value) => (TIME_FIELDS.has(key) ? undefined : value)))
    .digest('base64')

function disagreement(board: Board, now: Date) {
  const ours = view(board, { now })
  const gate = Object.fromEntries(
    ours.needsOwner
      .map((row: Json) => [row.id, (row.reasons as Json[]).find((reason) => reason.why !== 'delivery')?.why])
      .filter(([, why]: [number, string | undefined]) => why),
  )
  const theirs = boardView(board, now.getTime(), { cap: Number.POSITIVE_INFINITY })
  const dashboard = Object.fromEntries(theirs.gates.map((row: Json) => [row.id, row.gate.why]))
  const lead = (ours.withLead as Json[]).map((row) => row.id as number).sort((a, b) => a - b)
  const dashboardLead = (theirs.withLead as Json[]).map((row) => row.id as number).sort((a, b) => a - b)
  if (JSON.stringify(gate) !== JSON.stringify(dashboard))
    return `needsOwner ${JSON.stringify(gate)} but dashboard ${JSON.stringify(dashboard)}`
  if (JSON.stringify(lead) !== JSON.stringify(dashboardLead))
    return `withLead ${JSON.stringify(lead)} but dashboard ${JSON.stringify(dashboardLead)}`
  return null
}

describe('view agrees with the dashboard on every board a bounded search reaches', () => {
  it('lists the same tasks under needsOwner and withLead', () => {
    const start = freshBoard()
    add(start, GATED)
    let frontier: { board: Board; path: string[] }[] = [{ board: start, path: [] }]
    const seen = new Set([stateKey(start)])
    const problems: string[] = []
    let reached = 0
    for (let depth = 0; depth < 4; depth += 1) {
      const next: typeof frontier = []
      for (const { board, path } of frontier) {
        for (const step of STEPS) {
          const after = structuredClone(board)
          const now = new Date(START + (depth + 1) * 60_000)
          try {
            step.run(after, now)
          } catch {
            continue
          }
          const trail = [...path, step.name]
          const key = stateKey(after)
          if (seen.has(key)) continue
          seen.add(key)
          reached += 1
          const wrong = disagreement(after, new Date(now.getTime() + 1))
          if (wrong) problems.push(`${trail.join(' > ')}: ${wrong}`)
          next.push({ board: after, path: trail })
        }
      }
      frontier = next
    }
    expect(problems.slice(0, 5)).toEqual([])
    expect(reached).toBeGreaterThan(200)
  })
})
