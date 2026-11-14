import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, 'team-tasks.mjs')
const FAKE = join(import.meta.dirname, 'team-board-delivery.fake-t3.mjs')

// The CLI stamps `note`, `answer` and the other writes with the wall clock, and `deliver` reads TEAM_BOARD_NOW. A
// fixed date would sit in the past once the clock passes it and nothing would be due, so the sweeps run from ten
// minutes ahead of when this file loaded.
const T0 = Math.ceil((Date.now() + 10 * 60_000) / 1000) * 1000
const at = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString()

let dir: string
let board: string
let log: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-delivery-'))
  board = join(dir, 'tasks.json')
  log = join(dir, 't3.log')
  chmodSync(FAKE, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function scriptPath() {
  return resolve(import.meta.dirname, 'team-tasks.mjs')
}

function expectedMessage(
  id: number,
  title: string,
  headline: string,
  body: string,
  commands: { label: string; command: string }[],
  deliveryId: string,
) {
  const script = scriptPath()
  const show = `node ${script} show ${id}`
  return [
    `Team board, task ${id}: ${title}`,
    headline,
    '---',
    body,
    '---',
    `Read it:     ${show}`,
    ...commands.map(({ label, command }) => `${label}: node ${script} ${command}`),
    `Delivery ${deliveryId}. If you already handled this delivery, ignore it.`,
  ].join('\n')
}

function cli(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAM_TASKS_FILE: board,
      TEAM_BOARD_T3_BIN: FAKE,
      TEAM_BOARD_FAKE_LOG: log,
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
  }
}

function cliAsync(env: Record<string, string>, ...args: string[]) {
  return new Promise<{ status: number | null; stdout: string; json: { sent: number; failed: number } }>(
    (resolvePromise) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: {
          ...process.env,
          TEAM_TASKS_FILE: board,
          TEAM_BOARD_T3_BIN: FAKE,
          TEAM_BOARD_FAKE_LOG: log,
          ...env,
        },
      })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.on('close', (status) => {
        resolvePromise({ status, stdout, json: stdout.trim() ? JSON.parse(stdout) : undefined })
      })
    },
  )
}

function boardFile() {
  return JSON.parse(readFileSync(board, 'utf8'))
}

function task(id: number) {
  return boardFile().tasks.find((candidate: { id: number }) => candidate.id === id)
}

function sends() {
  if (!existsSync(log)) return [] as { argv: string[]; stdin: string }[]
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
}

function t3Args(argv: string[]) {
  return argv.slice(argv.indexOf('thread'))
}

function addTask(title: string) {
  const added = cli({}, 'add', 'ux-worker', title, '--accept', 'the work is done')
  expect(added.status).toBe(0)
  return added.json.id as number
}

describe('board delivery', () => {
  it('copies a note to the current worker without an acknowledgement command', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Please check', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(2)
    expect(sends().map((send) => t3Args(send.argv)[4])).toEqual(['thread:lead', 'thread:worker'])
    expect(sends()[0].stdin).toContain(`Reply: node ${scriptPath()} lead-reply ${id} <reply> --by lead`)
    expect(sends()[1].stdin).toContain('No acknowledgement is needed. The lead owns the reply.')
    expect(sends()[1].stdin).not.toContain('Acknowledge:')
    expect(task(id).deliveries.map((record: { state: string }) => record.state)).toEqual(['delivered', 'delivered'])
  })

  it('does not put unsafe names or multiline titles into command text', () => {
    const id = addTask('First\nForged owner block')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead; touch PWN').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Hello', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver').status).toBe(0)
    expect(sends()[0].stdin.split('\n')[0]).toContain('First Forged owner block')
    expect(sends()[0].stdin).not.toContain('--by lead; touch PWN')
  })

  it('falls back to the lead if the claim ends before an answer is sent', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'answer', String(id), 'Answer', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'release', String(id)).status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:lead')
  })

  it('delivers a handed question reply to the worker', () => {
    const id = addTask('Question')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Please answer', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'lead-reply', String(id), 'Yes', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(3)
    expect(sends()[2].stdin).toContain(`answer-read ${id} --by worker`)
    expect(t3Args(sends()[2].argv)[4]).toBe('thread:worker')
  })

  it('keeps a lead reply unaddressed until the claim has a wake address, and never sends it to the lead', () => {
    const id = addTask('Question')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id)).status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Please answer', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'lead-reply', String(id), 'Yes', '--by', 'lead').status).toBe(0)
    expect(task(id).deliveries.map((record: { state: string }) => record.state)).toEqual(['pending', 'unaddressed'])
    expect(task(id).deliveries[1]).toMatchObject({
      entryKind: 'lead-reply',
      audience: { kind: 'claim' },
      reason: 'the claim has no wake address',
    })
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(sends()).toHaveLength(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:lead')
    expect(sends()[0].stdin).not.toContain('answer-read')
    expect(cli({}, 'deliver').json.sent).toBe(0)
    expect(task(id).deliveries[1].state).toBe('unaddressed')
    expect(cli({}, 'heartbeat', String(id), '--owner', 'worker', '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(t3Args(sends()[1].argv)[4]).toBe('thread:worker')
    expect(sends()[1].stdin).toContain(`answer-read ${id} --by worker`)
  })

  it('fails a lead reply after six worker failures instead of retargeting it to the lead', () => {
    const id = addTask('Question')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id)).status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Please answer', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(cli({}, 'lead-reply', String(id), 'Yes', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'heartbeat', String(id), '--owner', 'worker', '--wake', 'thread:worker').status).toBe(0)
    let now = T0
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        cli({ TEAM_BOARD_NOW: new Date(now).toISOString(), TEAM_BOARD_FAKE_EXIT: '1' }, 'deliver').json.failed,
      ).toBe(1)
      now += 16 * 60_000
    }
    expect(task(id).deliveries[1]).toMatchObject({ state: 'failed', attempts: 6, threadId: 'thread:worker' })
    expect(sends().map((send) => t3Args(send.argv)[4])).toEqual(['thread:lead', ...Array(6).fill('thread:worker')])
  })

  it.each(['release', 'cancel', 'done'])('sends a stop notice on %s to the ended claim', (command) => {
    const id = cli({}, 'add', 'lead', 'Stop').json.id as number
    expect(cli({}, 'claim', 'lead', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(
      cli({}, command, String(id), '--by', 'lead', ...(command === 'done' ? ['--owner', 'worker'] : [])).status,
    ).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:worker')
    expect(sends()[0].stdin).toContain('Stop work')
    expect(sends()[0].stdin).not.toContain('Acknowledge:')
    expect(task(id).deliveries[0].state).toBe('delivered')
  })

  it('retargets after six worker failures, and permits retry after lead failure', () => {
    const id = addTask('Retry')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'answer', String(id), 'Answer', '--by', 'owner').status).toBe(0)
    let now = T0
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        cli({ TEAM_BOARD_NOW: new Date(now).toISOString(), TEAM_BOARD_FAKE_EXIT: '1' }, 'deliver').json.failed,
      ).toBe(1)
      now += 16 * 60_000
    }
    const retargeted = boardFile()
    retargeted.tasks[0].deliveries[0].attempts = 5
    writeFileSync(board, `${JSON.stringify(retargeted)}\n`)
    expect(cli({ TEAM_BOARD_NOW: new Date(now).toISOString(), TEAM_BOARD_FAKE_EXIT: '1' }, 'deliver').json.failed).toBe(
      1,
    )
    expect(task(id).deliveries[0].state).toBe('failed')
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:worker')
    expect(t3Args(sends()[6].argv)[4]).toBe('thread:lead')
    expect(
      cli({ TEAM_BOARD_NOW: new Date(now).toISOString() }, 'deliver-retry', String(id), `${id}-d1`, '--by', 'lead')
        .status,
    ).toBe(0)
    expect(cli({ TEAM_BOARD_NOW: new Date(now).toISOString() }, 'deliver').json.sent).toBe(1)
  })

  it('warns about undelivered messages and retains them when archiving', () => {
    const id = cli({}, 'add', 'lead', 'Archive').json.id as number
    expect(cli({}, 'claim', 'lead', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'cancel', String(id), '--by', 'lead').status).toBe(0)
    const saved = boardFile()
    saved.tasks[0].deliveries[0].state = 'unaddressed'
    saved.tasks[0].deliveries[0].since = '2020-01-01T00:00:00Z'
    delete saved.tasks[0].deliveries[0].nextAttemptAt
    writeFileSync(board, `${JSON.stringify(saved)}\n`)
    expect(JSON.stringify(cli({}, 'doctor').json)).toContain('undelivered-message')
    expect(cli({}, 'archive', '--older-than-days', '1').json.archived).toBe(0)
    expect(task(id).archived).not.toBe(true)
  })

  it('records the first result before a later send finishes', async () => {
    const first = addTask('First')
    const second = addTask('Second')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'note', String(first), 'First', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'note', String(second), 'Second', '--by', 'owner').status).toBe(0)
    const child = spawn(process.execPath, [CLI, 'deliver'], {
      env: {
        ...process.env,
        TEAM_TASKS_FILE: board,
        TEAM_BOARD_T3_BIN: FAKE,
        TEAM_BOARD_FAKE_LOG: log,
        TEAM_BOARD_FAKE_SLEEP_MS: '500',
      },
    })
    try {
      for (let i = 0; i < 60 && sends().length < 2; i += 1)
        await new Promise((resolveWait) => setTimeout(resolveWait, 40))
      expect(sends()).toHaveLength(2)
      expect(task(first).deliveries[0].state).toBe('delivered')
      expect(task(second).deliveries[0].state).toBe('sending')
    } finally {
      child.kill('SIGKILL')
      await new Promise((resolveWait) => child.once('close', resolveWait))
    }
  })
  it('writes a note into the outbox and deliver sends that text on stdin', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', '  lead  ').status).toBe(0)
    const noted = cli({}, 'note', String(id), 'Look at this', '--by', 'owner')
    expect(noted.status).toBe(0)
    const entry = task(id).decisions.at(-1)
    expect(entry.kind).toBe('note')
    expect(task(id).deliveries).toEqual([
      {
        id: `${id}-d1`,
        entryAt: entry.at,
        entryKind: 'note',
        audience: { kind: 'lead' },
        attempts: 0,
        state: 'pending',
        nextAttemptAt: entry.at,
      },
    ])
    const delivered = cli(
      {
        TEAM_BOARD_NOW: at(),
        TEAM_BOARD_FAKE_STDOUT: JSON.stringify({
          messageId: 'message:1',
          runId: 'run:1',
          status: 'queued',
        }),
      },
      'deliver',
    )
    expect(delivered.status).toBe(0)
    expect(delivered.json).toEqual({ sent: 1, failed: 0, nextDueAt: null })
    expect(sends()).toHaveLength(1)
    expect(t3Args(sends()[0].argv)).toEqual(['thread', 'send', '--json', '--', 'thread:lead', '-'])
    expect(sends()[0].stdin).toBe(
      expectedMessage(
        id,
        'Retry the flaky job',
        'The owner left a note.',
        'Look at this',
        [
          { label: 'Acknowledge', command: `note-read ${id} --by lead` },
          { label: 'Reply', command: `lead-reply ${id} <reply> --by lead` },
        ],
        `${id}-d1`,
      ),
    )
    expect(task(id).deliveries[0]).toEqual({
      id: `${id}-d1`,
      entryAt: entry.at,
      entryKind: 'note',
      audience: { kind: 'lead' },
      attempts: 0,
      state: 'delivered',
      deliveredAt: at(),
      threadId: 'thread:lead',
      t3: { messageId: 'message:1', runId: 'run:1' },
    })
  })

  it('sends an answer to the claim wake when the claim has one', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Which belt?', '--by', 'worker').status).toBe(0)
    const answered = cli({}, 'answer', String(id), 'Use a belt.', '--by', 'owner')
    expect(answered.status).toBe(0)
    const entry = task(id).decisions.at(-1)
    expect(task(id).deliveries).toEqual([
      {
        id: `${id}-d1`,
        entryAt: entry.at,
        entryKind: 'owner-answer',
        audience: { kind: 'claim' },
        attempts: 0,
        state: 'pending',
        nextAttemptAt: entry.at,
      },
    ])
    const delivered = cli({ TEAM_BOARD_NOW: at() }, 'deliver')
    expect(delivered.json).toEqual({ sent: 1, failed: 0, nextDueAt: null })
    expect(t3Args(sends()[0].argv)).toEqual(['thread', 'send', '--json', '--', 'thread:worker', '-'])
    expect(sends()[0].stdin).toBe(
      expectedMessage(
        id,
        'Retry the flaky job',
        'The owner answered your question.',
        'Use a belt.',
        [{ label: 'Acknowledge', command: `answer-read ${id} --by worker` }],
        `${id}-d1`,
      ),
    )
    expect(task(id).deliveries[0].t3).toEqual({ messageId: 'message:fake', runId: 'run:fake' })
  })

  it('keeps the note body to 2,000 characters', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    const body = 'ab '.repeat(667)
    expect(cli({}, 'note', String(id), body, '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver').status).toBe(0)
    expect(sends()[0].stdin.split('\n---\n')[1]).toBe(body.slice(0, 2000))
  })

  it('backs off six failing sends and then gives up', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Look at this', '--by', 'owner').status).toBe(0)
    const start = T0
    const gaps = [30, 60, 120, 240, 480].map((seconds) => seconds * 1000)
    let now = start
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = cli(
        { TEAM_BOARD_NOW: new Date(now).toISOString(), TEAM_BOARD_FAKE_EXIT: '1', TEAM_BOARD_FAKE_STDERR: 'down' },
        'deliver',
      )
      expect(result.status).toBe(0)
      expect(result.json).toMatchObject({ sent: 0, failed: 1 })
      const record = task(id).deliveries[0]
      expect(record.state).toBe('pending')
      expect(record.attempts).toBe(attempt)
      expect(record.error).toBeUndefined()
      expect(record.nextAttemptAt).toBe(new Date(now + gaps[attempt - 1]).toISOString())
      now += gaps[attempt - 1]
    }
    const last = cli(
      {
        TEAM_BOARD_NOW: new Date(now).toISOString(),
        TEAM_BOARD_FAKE_EXIT: '1',
        TEAM_BOARD_FAKE_STDERR: 'x'.repeat(400),
      },
      'deliver',
    )
    expect(last.json).toMatchObject({ sent: 0, failed: 1, nextDueAt: null })
    expect(task(id).deliveries[0]).toMatchObject({
      state: 'failed',
      attempts: 6,
      failedAt: new Date(now).toISOString(),
      threadId: 'thread:lead',
      error: 'x'.repeat(300),
    })
    expect(task(id).deliveries[0].nextAttemptAt).toBeUndefined()
    expect(sends()).toHaveLength(6)
    const again = cli({ TEAM_BOARD_NOW: new Date(now + 60_000).toISOString(), TEAM_BOARD_FAKE_EXIT: '1' }, 'deliver')
    expect(again.json).toEqual({ sent: 0, failed: 0, nextDueAt: null })
    expect(sends()).toHaveLength(6)
    expect(task(id).deliveries[0].state).toBe('failed')
  })

  it('retries a sending lease after it expires and leaves a live lease alone', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Look at this', '--by', 'owner').status).toBe(0)
    const saved = boardFile()
    const record = saved.tasks[0].deliveries[0]
    saved.tasks[0].deliveries[0] = {
      id: record.id,
      entryAt: record.entryAt,
      entryKind: record.entryKind,
      audience: record.audience,
      attempts: 0,
      state: 'sending',
      leaseUntil: at(120_000),
      token: 'killed-sweep',
      threadId: 'thread:lead',
    }
    writeFileSync(board, `${JSON.stringify(saved, null, 2)}\n`)
    const early = cli({ TEAM_BOARD_NOW: at() }, 'deliver')
    expect(early.json).toEqual({ sent: 0, failed: 0, nextDueAt: at(120_000) })
    expect(sends()).toEqual([])
    expect(task(id).deliveries[0].state).toBe('sending')
    const late = cli({ TEAM_BOARD_NOW: at(120_000) }, 'deliver')
    expect(late.json).toEqual({ sent: 1, failed: 0, nextDueAt: null })
    expect(sends()).toHaveLength(1)
    expect(t3Args(sends()[0].argv)).toEqual(['thread', 'send', '--json', '--', 'thread:lead', '-'])
    expect(task(id).deliveries[0].state).toBe('delivered')
    expect(task(id).deliveries[0].id).toBe(`${id}-d1`)
  })

  it('leaves a note unaddressed until a lead thread exists', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'note', String(id), 'Look at this', '--by', 'owner').status).toBe(0)
    const waiting = cli({ TEAM_BOARD_NOW: at() }, 'deliver')
    expect(waiting.json).toEqual({ sent: 0, failed: 0, nextDueAt: null })
    expect(sends()).toEqual([])
    expect(task(id).deliveries[0]).toMatchObject({
      state: 'unaddressed',
      audience: { kind: 'lead' },
      reason: 'the board has no lead address',
    })
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    const delivered = cli({ TEAM_BOARD_NOW: at(300_000) }, 'deliver')
    expect(delivered.json).toEqual({ sent: 1, failed: 0, nextDueAt: null })
    expect(t3Args(sends()[0].argv)).toEqual(['thread', 'send', '--json', '--', 'thread:lead', '-'])
    expect(task(id).deliveries[0].state).toBe('delivered')
  })

  it('sends once when two sweeps run together', async () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Look at this', '--by', 'owner').status).toBe(0)
    const [first, second] = await Promise.all([
      cliAsync({ TEAM_BOARD_FAKE_SLEEP_MS: '400' }, 'deliver'),
      cliAsync({ TEAM_BOARD_FAKE_SLEEP_MS: '400' }, 'deliver'),
    ])
    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(first.json.sent + second.json.sent).toBe(1)
    expect(first.json.failed + second.json.failed).toBe(0)
    expect(sends()).toHaveLength(1)
    expect(task(id).deliveries[0].state).toBe('delivered')
  })

  it('refuses a thread id that starts with a dash and does not spawn', () => {
    const id = addTask('Retry the flaky job')
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', '-worker').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Which belt?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'answer', String(id), 'Use a belt.', '--by', 'owner').status).toBe(0)
    const now = at()
    const refused = cli({ TEAM_BOARD_NOW: now }, 'deliver')
    expect(refused.json).toEqual({ sent: 0, failed: 1, nextDueAt: null })
    expect(sends()).toEqual([])
    expect(task(id).deliveries[0]).toMatchObject({
      state: 'failed',
      attempts: 1,
      threadId: '-worker',
      failedAt: now,
      error: 'refusing thread id "-worker": a thread id must not start with "-"',
    })
    const again = cli({ TEAM_BOARD_NOW: at(3_600_000) }, 'deliver')
    expect(again.json).toEqual({ sent: 0, failed: 0, nextDueAt: null })
    expect(sends()).toEqual([])
  })

  it('names the owner, a lead and a worker from the entry by', () => {
    const id = addTask('Authors')
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'note', String(id), 'From the owner', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'note', String(id), 'From the lead', '--by', 'area-lead').status).toBe(0)
    expect(cli({}, 'note', String(id), 'From the worker', '--by', 'worker-a').status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(3)
    const headlines = sends().map((send: { stdin: string }) => send.stdin.split('\n')[1])
    expect(headlines).toEqual(['The owner left a note.', 'area-lead left a note.', 'worker-a left a note.'])
    expect(cli({}, 'claim', 'ux-worker', 'worker', '--id', String(id), '--wake', 'thread:worker').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Which belt?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'answer', String(id), 'A reviewer answered.', '--by', 'reviewer').status).toBe(0)
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(sends().at(-1)?.stdin.split('\n')[1]).toBe('reviewer answered your question.')
  })

  it('resolves a lead address from the task, then its tag, then the board', () => {
    const tagged = cli({}, 'add', 'ux-worker', 'Tagged', '--accept', 'done', '--tag', 'board-kanban').json.id as number
    const other = cli({}, 'add', 'ux-worker', 'Other', '--accept', 'done', '--tag', 'progress').json.id as number
    expect(cli({}, 'lead-wake', 'thread:board', '--by', 'board-lead').status).toBe(0)
    expect(cli({}, 'lead-wake', 'thread:tag', '--tag', 'board-kanban', '--by', 'tag-lead').status).toBe(0)
    expect(cli({}, 'lead-wake', 'thread:task', '--task', String(tagged), '--by', 'task-lead').status).toBe(0)
    expect(cli({}, 'note', String(tagged), 'Own lead', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver', '--task', String(tagged)).json.sent).toBe(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:task')
    expect(cli({}, 'lead-wake', '--clear', '--task', String(tagged), '--by', 'task-lead').status).toBe(0)
    expect(cli({}, 'note', String(tagged), 'Tag lead', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver', '--task', String(tagged)).json.sent).toBe(1)
    expect(t3Args(sends()[1].argv)[4]).toBe('thread:tag')
    expect(cli({}, 'note', String(other), 'Board lead', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'deliver', '--task', String(other)).json.sent).toBe(1)
    expect(t3Args(sends()[2].argv)[4]).toBe('thread:board')
    const viewed = cli({}, 'view').json
    expect(viewed.version).toBe(1)
    expect(viewed.lead.threadId).toBe('thread:board')
    expect(viewed.leadTags['board-kanban'].threadId).toBe('thread:tag')
    const card = viewed.tasks.find((row: { id: number }) => row.id === tagged)
    expect(card.leadAddress).toMatchObject({ source: 'tag', threadId: 'thread:tag', by: 'tag-lead' })
    expect(cli({}, 'doctor').json.findings).toContainEqual(
      expect.objectContaining({
        code: 'tag-lead-wake',
        message: expect.stringContaining('tag board-kanban lead address is thread:tag'),
      }),
    )
    expect(cli({}, 'lead-wake', 'thread:x', '--tag', 'Bad Tag', '--by', 'lead').status).toBe(1)
    expect(cli({}, 'lead-wake', 'thread:x', '--tag', 'ok', '--task', String(tagged), '--by', 'lead').status).toBe(1)
    expect(boardFile().tagLeadWakes['board-kanban'].threadId).toBe('thread:tag')
  })

  it.each(['done', 'release', 'cancel'] as const)(
    'fails a claim-only lead reply when the claim ends by %s',
    (command) => {
      const id = cli({}, 'add', 'lead', 'Reply').json.id as number
      expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
      expect(cli({}, 'claim', 'lead', 'worker', '--id', String(id)).status).toBe(0)
      expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
      expect(cli({}, 'note', String(id), 'Please answer', '--by', 'owner').status).toBe(0)
      expect(cli({}, 'deliver').json.sent).toBe(1)
      expect(cli({}, 'lead-reply', String(id), 'Yes', '--by', 'lead').status).toBe(0)
      const reply = () => task(id).deliveries.find((record: { entryKind: string }) => record.entryKind === 'lead-reply')
      expect(reply()).toMatchObject({ state: 'unaddressed', audience: { kind: 'claim' } })
      if (command === 'done') expect(cli({}, 'answer-read', String(id), '--by', 'worker').status).toBe(0)
      const ended =
        command === 'done'
          ? cli({}, 'done', String(id), '--owner', 'worker')
          : cli({}, command, String(id), '--by', 'lead', ...(command === 'cancel' ? ['--reason', 'stopped'] : []))
      expect(ended.status, ended.stderr).toBe(0)
      expect(reply()).toMatchObject({
        state: 'failed',
        error: 'the claim ended before it had a wake address',
      })
      if (command === 'done') expect(cli({}, 'archive', '--id', String(id)).json.archived).toBe(1)
    },
  )

  it('does not deliver an old lead reply to the worker who reclaims', () => {
    const id = cli({}, 'add', 'lead', 'Handoff').json.id as number
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'claim', 'lead', 'worker', '--id', String(id), '--wake', 'thread:old').status).toBe(0)
    expect(cli({}, 'ask-owner', String(id), 'Question?', '--by', 'worker').status).toBe(0)
    expect(cli({}, 'note', String(id), 'Please answer', '--by', 'owner').status).toBe(0)
    expect(cli({}, 'lead-reply', String(id), 'Yes', '--by', 'lead').status).toBe(0)
    expect(cli({}, 'release', String(id), '--by', 'lead').status).toBe(0)
    const reply = task(id).deliveries.find((record: { entryKind: string }) => record.entryKind === 'lead-reply')
    expect(reply).toMatchObject({
      state: 'failed',
      error: 'the claim ended before this message was delivered',
    })
    expect(cli({}, 'claim', 'lead', 'next-worker', '--id', String(id), '--wake', 'thread:new').status).toBe(0)
    expect(cli({}, 'deliver').status).toBe(0)
    expect(
      sends()
        .map((send: { stdin: string }) => send.stdin)
        .join('\n'),
    ).not.toContain('\nYes\n')
    expect(task(id).deliveries.find((record: { entryKind: string }) => record.entryKind === 'lead-reply').state).toBe(
      'failed',
    )
  })
})

// #2301: an owner Accept queues one delivery in the same locked write as the decision.
describe('accept delivery', () => {
  interface Delivery {
    id: string
    entryAt: string
    entryKind: string
    audience: { kind: string }
    attempts: number
    state: string
    nextAttemptAt?: string
    reason?: string
    threadId?: string
  }

  const HASH = 'ab'.repeat(32)
  const REASON = 'Looks right to me. Ship it.'

  function check(id: number, by: string, outcome: 'hold' | 'confirmed' | 'rejected') {
    const basis = (task(id).decisions ?? []).length
    return cli(
      {},
      'judgment',
      String(id),
      JSON.stringify({
        basis,
        kind: 'judgment',
        at: at(-60_000),
        by,
        tool: 'check',
        question: 'Does the evidence pass?',
        outcome,
        answer: outcome === 'hold' ? null : 'fits',
        p: 0.5,
        confidence: null,
        reasons: [],
        evidence: ['a.png'],
        requestHash: HASH,
        receipt: '/tmp/r.json',
      }),
    )
  }

  /** A claimed task whose latest check is a hold on its current evidence. */
  function heldTask({
    title = 'Retry the flaky job',
    owner = 'worker',
    wake = 'thread:worker',
    tag,
    outcome = 'hold',
  }: {
    title?: string
    owner?: string
    wake?: string | null
    tag?: string
    outcome?: 'hold' | 'confirmed' | 'rejected'
  } = {}) {
    const added = cli({}, 'add', 'ux-worker', title, '--accept', 'the work is done', ...(tag ? ['--tag', tag] : []))
    expect(added.status).toBe(0)
    const id = added.json.id as number
    expect(cli({}, 'claim', 'ux-worker', owner, '--id', String(id), ...(wake ? ['--wake', wake] : [])).status).toBe(0)
    expect(cli({}, 'evidence', String(id), 'a.png').status).toBe(0)
    const checked = check(id, owner, outcome)
    expect(checked.status, checked.stderr).toBe(0)
    return id
  }

  const deliveries = (id: number): Delivery[] => task(id).deliveries ?? []
  const acceptRecords = (id: number) => deliveries(id).filter((record) => record.entryKind === 'accept')

  function accept(id: number, by = 'owner', reason = REASON) {
    return cli({}, 'accept', String(id), '--reason', reason, '--by', by)
  }

  it('queues one pending claim delivery addressed to the claim wake thread', () => {
    const id = heldTask()
    expect(cli({}, 'lead-wake', 'thread:lead', '--by', 'lead').status).toBe(0)
    const before = deliveries(id).length
    const accepted = accept(id)
    expect(accepted.status, accepted.stderr).toBe(0)
    const entry = task(id).decisions.at(-1)
    expect(entry.kind).toBe('accept')
    expect(deliveries(id)).toHaveLength(before + 1)
    expect(acceptRecords(id)).toEqual([
      {
        id: `${id}-d${before + 1}`,
        entryAt: entry.at,
        entryKind: 'accept',
        audience: { kind: 'claim' },
        attempts: 0,
        state: 'pending',
        nextAttemptAt: entry.at,
      },
    ])
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:worker')
  })

  it('falls back to the board lead address when the claim has no wake address', () => {
    const id = heldTask({ wake: null })
    expect(cli({}, 'lead-wake', 'thread:board', '--by', 'board-lead').status).toBe(0)
    expect(accept(id).status).toBe(0)
    expect(acceptRecords(id)).toHaveLength(1)
    expect(deliveries(id)).toHaveLength(1)
    expect(acceptRecords(id)[0]).toMatchObject({ audience: { kind: 'lead' }, state: 'pending' })
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:board')
  })

  it('addresses the lead copy to the tag lead address ahead of the board address', () => {
    const id = heldTask({ wake: null, tag: 'board-kanban' })
    expect(cli({}, 'lead-wake', 'thread:board', '--by', 'board-lead').status).toBe(0)
    expect(cli({}, 'lead-wake', 'thread:tag', '--tag', 'board-kanban', '--by', 'tag-lead').status).toBe(0)
    expect(accept(id).status).toBe(0)
    expect(deliveries(id)).toHaveLength(1)
    expect(acceptRecords(id)[0]).toMatchObject({ audience: { kind: 'lead' }, state: 'pending' })
    expect(cli({}, 'deliver').json.sent).toBe(1)
    expect(t3Args(sends()[0].argv)[4]).toBe('thread:tag')
  })

  it('records an unaddressed delivery when there is no wake and no lead address, and accept still succeeds', () => {
    const id = heldTask({ wake: null })
    const accepted = accept(id)
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(task(id).decisions.at(-1).kind).toBe('accept')
    expect(deliveries(id)).toHaveLength(1)
    expect(acceptRecords(id)[0]).toMatchObject({ entryKind: 'accept', state: 'unaddressed' })
    expect(cli({}, 'deliver').json.sent).toBe(0)
    expect(sends()).toEqual([])
  })

  describe('message text', () => {
    function sentMessage(id: number, by: string, reason = REASON) {
      expect(accept(id, by, reason).status).toBe(0)
      expect(cli({}, 'deliver').json.sent).toBe(1)
      return sends()[0].stdin
    }

    it('names the task, shows the owner as "The owner", and puts the reason between the --- lines', () => {
      const id = heldTask({ title: 'Retry the\nflaky job' })
      const message = sentMessage(id, 'owner')
      const lines = message.split('\n')
      expect(lines[0]).toBe(`Team board, task ${id}: Retry the flaky job`)
      expect(lines[1]).toContain('The owner')
      expect(message.split('\n---\n')[1]).toBe(REASON)
      expect(message).toContain(`Read it:     node ${scriptPath()} show ${id}`)
    })

    it('shows any other accepter by name', () => {
      const id = heldTask()
      const message = sentMessage(id, 'area-lead')
      expect(message.split('\n')[1]).toContain('area-lead')
      expect(message).not.toContain('The owner')
    })

    it('ends with a Finish command line for a safe claim owner', () => {
      const id = heldTask({ owner: 'worker.v2-a' })
      const message = sentMessage(id, 'owner')
      expect(message).toContain(`\nFinish: node ${scriptPath()} done ${id} --owner worker.v2-a\n`)
    })

    it('gives an unsafe claim owner no command line', () => {
      const id = heldTask({ owner: 'worker; touch PWN' })
      const message = sentMessage(id, 'owner')
      expect(message).not.toContain('Finish:')
      expect(message).not.toContain('touch PWN')
    })
  })

  it('delivers once through the notifier and marks the record delivered', () => {
    const id = heldTask()
    expect(accept(id).status).toBe(0)
    const delivered = cli({ TEAM_BOARD_NOW: at() }, 'deliver')
    expect(delivered.json).toEqual({ sent: 1, failed: 0, nextDueAt: null })
    expect(sends()).toHaveLength(1)
    expect(t3Args(sends()[0].argv)).toEqual(['thread', 'send', '--json', '--', 'thread:worker', '-'])
    expect(acceptRecords(id)[0]).toMatchObject({ state: 'delivered', threadId: 'thread:worker', deliveredAt: at() })
    expect(cli({ TEAM_BOARD_NOW: at(60_000) }, 'deliver').json).toEqual({ sent: 0, failed: 0, nextDueAt: null })
    expect(sends()).toHaveLength(1)
    expect(acceptRecords(id)[0].state).toBe('delivered')
  })

  describe('a refused accept queues nothing and leaves the board unchanged', () => {
    function expectRefused(id: number, run: () => { status: number | null; stderr: string }, message: string) {
      const before = readFileSync(board, 'utf8')
      const refused = run()
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain(message)
      expect(readFileSync(board, 'utf8')).toBe(before)
      expect(acceptRecords(id)).toEqual([])
    }

    it('when the latest check is not a hold', () => {
      const id = heldTask({ outcome: 'rejected' })
      expectRefused(id, () => accept(id), 'rejected')
    })

    it('when the evidence changed since the check', () => {
      const id = heldTask()
      expect(cli({}, 'evidence', String(id), 'b.png').status).toBe(0)
      expectRefused(id, () => accept(id), 'evidence changed')
    })

    it('when --by is the claim owner', () => {
      const id = heldTask()
      expectRefused(id, () => accept(id, 'worker'), 'differ')
    })
  })
})
