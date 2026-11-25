// The thread's server side, against a scratch board built with the real board CLI and the fake `t3` the delivery tests
// use. Nothing here touches the owner's board or sends to a real T3 thread.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { CLI, addTask, claimTask, cli, cliJson, judgeCheck } from '../../tests/temp-board'
import { parseThreadEnvelope, parseWriteEnvelope } from '../thread/thread-contract'
import { newToken } from './access.server'
import { runBoardView } from './board-cli.server'
import type { Config } from './board-config.server'
import { deliveryIdle } from './delivery.server'
import {
  acceptResponse,
  buildThread,
  leadResponse,
  listThreads,
  retryResponse,
  sendResponse,
  threadResponse,
  type Deps,
} from './thread.server'
import { methodNotAllowed } from './write-guard.server'

const FAKE = join(import.meta.dirname, '../../../../scripts/team-board-delivery.fake-t3.mjs')
const PORT = 4799
const TOKEN = newToken()

const scratch = mkdtempSync(join(tmpdir(), 'board-thread-'))
const log = join(scratch, 't3.log')
const saved = { ...process.env }
afterAll(() => {
  process.env = saved
  rmSync(scratch, { recursive: true, force: true })
})

let file: string
let deps: Deps
let taskId: number
let counter = 0

const ENV_KEYS = [
  'TEAM_BOARD_FAKE_EXIT',
  'TEAM_BOARD_FAKE_STDERR',
  'TEAM_BOARD_FAKE_SLEEP_MS',
  'TEAM_BOARD_NOW',
] as const

beforeEach(() => {
  chmodSync(FAKE, 0o755)
  rmSync(log, { force: true })
  process.env.TEAM_BOARD_T3_BIN = FAKE
  process.env.TEAM_BOARD_FAKE_LOG = log
  for (const key of ENV_KEYS) delete process.env[key]
  file = join(scratch, `board-${counter++}`, 'tasks.json')
  mkdirSync(dirname(file), { recursive: true })
  taskId = addTask(file, 'backend-worker', 'Thread probe', { tag: 'server' })
  claimTask(file, 'backend-worker', 'worker-backend', taskId)
  cli(file, ['lead-wake', 'thread:lead', '--by', 'lead'])
  cli(file, ['heartbeat', String(taskId), '--owner', 'worker-backend', '--wake', 'thread:worker'])
  const config: Config = {
    cli: CLI,
    repo: join(CLI, '..', '..'),
    project: join(CLI, '..', '..'),
    boardFile: file,
    node: process.execPath,
    t3: FAKE,
    port: PORT,
    buildSha: null,
    tailnet: null,
  }
  deps = { config, token: TOKEN }
})

const sentLog = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
    : []

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${PORT}`,
      'content-type': 'application/json',
      'x-board-token': TOKEN,
      origin: `http://127.0.0.1:${PORT}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

type Journal = {
  decisions?: { kind: string; by?: string; text?: string }[]
  deliveries?: { id: string; state: string }[]
}
const journal = () => cliJson<Journal>(file, ['show', String(taskId)])
const entries = () => journal().decisions ?? []

async function outcome(response: Response) {
  const parsed = parseWriteEnvelope.safeParse(await response.text())
  if (!parsed.success) throw new Error('not a write envelope')
  return parsed.data
}

async function readThread() {
  const parsed = parseThreadEnvelope.safeParse(await (await threadResponse(String(taskId), deps)).text())
  if (!parsed.success || !parsed.data.ok) throw new Error('thread unreadable')
  return parsed.data.thread
}

const send = (body: unknown, headers?: Record<string, string>) =>
  sendResponse(post(`/api/thread/${taskId}/send`, body, headers), String(taskId), deps)

describe('the write guard', () => {
  const note = { kind: 'note', text: 'hello' }

  it.each([
    ['without the token', { 'x-board-token': '' }],
    ['with a wrong token', { 'x-board-token': 'x'.repeat(64) }],
    ['with a foreign Origin', { origin: 'https://evil.example' }],
    ['with a foreign Host', { host: 'evil.example' }],
  ])('refuses a write %s and writes nothing', async (_name, headers) => {
    const response = await send(note, headers)
    expect(response.status).toBe(403)
    expect((await outcome(response)).ok).toBe(false)
    expect(entries()).toEqual([])
    expect(sentLog()).toEqual([])
  })

  it('guards every write route the same way', async () => {
    const noToken = { 'x-board-token': '' }
    const responses = await Promise.all([
      sendResponse(post('/x', note, noToken), String(taskId), deps),
      retryResponse(post('/x', { deliveryId: '1-d1' }, noToken), String(taskId), deps),
      acceptResponse(post('/x', { reason: 'fine' }, noToken), String(taskId), deps),
      leadResponse(post('/x', { threadId: 'thread:x' }, noToken), deps),
    ])
    for (const response of responses) expect(response.status).toBe(403)
  })

  it('answers any other method with 405 and an Allow header', async () => {
    const get = new Request(`http://127.0.0.1:${PORT}/api/thread/${taskId}/send`, {
      headers: { host: `127.0.0.1:${PORT}` },
    })
    const response = await sendResponse(get, String(taskId), deps)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(methodNotAllowed(['GET']).headers.get('allow')).toBe('GET')
  })

  it('refuses a body that is not JSON, is too large, or is not the right shape', async () => {
    const notJson = new Request(`http://127.0.0.1:${PORT}/x`, {
      method: 'POST',
      headers: { host: `127.0.0.1:${PORT}`, 'x-board-token': TOKEN, 'content-type': 'text/plain' },
      body: 'hi',
    })
    expect((await sendResponse(notJson, String(taskId), deps)).status).toBe(400)
    expect((await send({ kind: 'note', text: 'x'.repeat(20_000) })).status).toBe(400)
    for (const bad of [
      {},
      { kind: 'shout', text: 'hi' },
      { kind: 'note', text: '   ' },
      { kind: 'note', text: 'a\0b' },
    ]) {
      expect((await send(bad)).status).toBe(400)
    }
    expect(entries()).toEqual([])
    expect(sentLog()).toEqual([])
  })

  it('refuses a task id that is not a plain number', async () => {
    const response = await sendResponse(post('/x', note), '1; rm -rf', deps)
    expect(response.status).toBe(404)
  })
})

describe('sending a note', () => {
  it('signs the write as the owner, ignoring any name in the body, and keeps flag-like words as text', async () => {
    const text = 'please run it with --by attacker and --release'
    const response = await send({ kind: 'note', text, by: 'attacker' })
    expect(await outcome(response)).toEqual({ ok: true })
    expect(entries().find((entry) => entry.kind === 'note')).toMatchObject({ by: 'owner', text })
    await deliveryIdle()
  })

  it('shows the board its own refusal when the text starts with two dashes', async () => {
    const response = await send({ kind: 'note', text: '--by attacker' })
    const result = await outcome(response)
    expect(response.status).toBe(409)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.message).toContain('must not start with --')
    expect(entries()).toEqual([])
  })

  it('asks the board to deliver after the write, and the thread then shows both deliveries as delivered', async () => {
    const response = await send({ kind: 'note', text: 'Please check the empty state' })
    expect(response.status).toBe(200)
    await deliveryIdle()
    expect(sentLog().length).toBe(2)
    const thread = await readThread()
    expect(thread.deliveries.map((delivery) => delivery.state)).toEqual(['delivered', 'delivered'])
    expect(thread.entries.some((entry) => entry.kind === 'note' && entry.text === 'Please check the empty state')).toBe(
      true,
    )
  })

  it('does not hold the response for the delivery', async () => {
    process.env.TEAM_BOARD_FAKE_SLEEP_MS = '1500'
    const started = Date.now()
    const response = await send({ kind: 'note', text: 'slow thread' })
    const elapsed = Date.now() - started
    expect(response.status).toBe(200)
    expect(elapsed).toBeLessThan(1200)
    await deliveryIdle()
  })
})

describe('answering a question', () => {
  const ask = () => cli(file, ['ask-owner', String(taskId), 'Which tab opens first?', '--by', 'worker-backend'])

  it('answers the open question against its review revision and sends the answer to the worker', async () => {
    ask()
    const thread = await readThread()
    expect(thread.thread?.question).toBe('Asked')
    const response = await send({ kind: 'answer', text: 'Needs me first', expected: thread.reviewRevision })
    expect(await outcome(response)).toEqual({ ok: true })
    await deliveryIdle()
    expect(sentLog().some((sent) => sent.argv.includes('thread:worker'))).toBe(true)
    expect((await readThread()).thread?.question).toBe('Answered')
  })

  it('refuses an answer against a stale review revision and leaves the journal alone', async () => {
    ask()
    const response = await send({ kind: 'answer', text: 'Old news', expected: 'a'.repeat(64) })
    expect(response.status).toBe(409)
    expect((await outcome(response)).ok).toBe(false)
    expect(entries().some((entry) => entry.kind === 'owner-answer')).toBe(false)
  })
})

describe('a message that cannot be delivered', () => {
  /** Six sweeps, each an hour apart, take a delivery past its six attempts. */
  function sweepUntilFailed() {
    for (let hour = 1; hour <= 6; hour++) {
      process.env.TEAM_BOARD_NOW = new Date(Date.now() + hour * 60 * 60_000).toISOString()
      cli(file, ['deliver'])
    }
    delete process.env.TEAM_BOARD_NOW
  }

  it('shows the failure with its reason and attempts, and Retry sends it once more', async () => {
    process.env.TEAM_BOARD_FAKE_EXIT = '1'
    process.env.TEAM_BOARD_FAKE_STDERR = 'thread not found'
    expect((await send({ kind: 'note', text: 'try me' })).status).toBe(200)
    await deliveryIdle()
    expect((await readThread()).deliveries.every((delivery) => delivery.state === 'pending')).toBe(true)

    sweepUntilFailed()
    const failed = (await readThread()).deliveries.filter((delivery) => delivery.state === 'failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0]).toMatchObject({ attempts: 6 })
    expect(failed[0]?.error).toContain('thread not found')

    delete process.env.TEAM_BOARD_FAKE_EXIT
    const target = failed[0]
    if (!target) throw new Error('no failed delivery')
    const retried = await retryResponse(post('/x', { deliveryId: target.id }), String(taskId), deps)
    expect(retried.status).toBe(200)
    await deliveryIdle()
    const after = (await readThread()).deliveries.find((delivery) => delivery.id === target.id)
    expect(after?.state).toBe('delivered')
  })

  it('refuses a retry id that is not a delivery id', async () => {
    const response = await retryResponse(post('/x', { deliveryId: '--all' }), String(taskId), deps)
    expect(response.status).toBe(400)
  })
})

describe('the lead thread', () => {
  it('sets the board lead and a tag lead, and clears the tag lead', async () => {
    expect(await outcome(await leadResponse(post('/x', { threadId: 'thread:new-lead' }), deps))).toEqual({ ok: true })
    expect(await outcome(await leadResponse(post('/x', { threadId: 'thread:tag-lead', tag: 'server' }), deps))).toEqual(
      { ok: true },
    )
    let view = await runBoardView(deps.config, {})
    if (!view.ok) throw new Error('view failed')
    expect(view.value.lead?.threadId).toBe('thread:new-lead')
    expect(view.value.leadTags?.server?.threadId).toBe('thread:tag-lead')

    expect(await outcome(await leadResponse(post('/x', { tag: 'server' }), deps))).toEqual({ ok: true })
    view = await runBoardView(deps.config, {})
    if (!view.ok) throw new Error('view failed')
    expect(view.value.leadTags?.server).toBeUndefined()
    await deliveryIdle()
  })

  it('refuses a thread id that could be read as a flag', async () => {
    for (const threadId of ['--clear', 'has space', '']) {
      const response = await leadResponse(post('/x', { threadId }), deps)
      expect(response.status).toBe(400)
    }
  })
})

describe('reading a thread', () => {
  it('answers a task the board does not have with 404', async () => {
    const response = await threadResponse('99999', deps)
    expect(response.status).toBe(404)
  })

  it('keeps a delivery state or journal kind it does not know, and never passes the send token on', async () => {
    const view = await runBoardView(deps.config, {})
    if (!view.ok) throw new Error('view failed')
    const thread = buildThread(
      {
        id: taskId,
        status: 'claimed',
        decisions: [{ kind: 'from-the-future', at: '2030-01-01T00:00:00Z', text: 'hi' }, 'not an object'],
        deliveries: [
          {
            id: '1-d1',
            entryKind: 'note',
            entryAt: '2030-01-01T00:00:00Z',
            state: 'parked',
            attempts: 1,
            audience: { kind: 'claim' },
            sendToken: 'SECRET-TOKEN',
          },
        ],
      },
      view.value,
    )
    expect(thread.entries.map((entry) => entry.kind)).toEqual(['from-the-future'])
    expect(thread.deliveries[0]?.state).toBe('parked')
    expect(JSON.stringify(thread)).not.toContain('SECRET-TOKEN')
  })
})

// #2305: an accept queues a delivery, so the app must ask the board to deliver it at once, as send and retry do.
describe('accepting a held check kicks delivery', () => {
  const accept = (body: unknown, headers?: Record<string, string>) =>
    acceptResponse(post(`/api/thread/${taskId}/accept`, body, headers), String(taskId), deps)
  const acceptEntries = () => entries().filter((entry) => entry.kind === 'accept')

  it('kicks delivery for this task once the accept is written, and the accept delivery shows as delivered', async () => {
    judgeCheck(file, taskId, 'worker-backend', 'hold')
    const response = await accept({ reason: 'I read the log myself and it shows the fix' })
    expect(response.status).toBe(200)
    expect(await outcome(response)).toEqual({ ok: true })
    await deliveryIdle()
    expect(sentLog().some((sent) => sent.argv.includes('thread:worker'))).toBe(true)
    const thread = await readThread()
    expect(thread.deliveries.find((delivery) => delivery.entryKind === 'accept')?.state).toBe('delivered')
  })

  it('kicks nothing when the board CLI refuses the accept', async () => {
    // Claimed, but no held check: the CLI refuses the accept and writes nothing.
    const response = await accept({ reason: 'no check to accept' })
    expect((await outcome(response)).ok).toBe(false)
    await deliveryIdle()
    expect(sentLog()).toEqual([])
    expect(acceptEntries()).toEqual([])
  })

  it.each([
    ['without the token', { 'x-board-token': '' }],
    ['with a wrong token', { 'x-board-token': 'x'.repeat(64) }],
    ['with a foreign Origin', { origin: 'https://evil.example' }],
  ])('kicks nothing for an accept refused by the guard %s', async (_name, headers) => {
    judgeCheck(file, taskId, 'worker-backend', 'hold')
    const response = await accept({ reason: 'fine' }, headers)
    expect(response.status).toBe(403)
    expect((await outcome(response)).ok).toBe(false)
    await deliveryIdle()
    expect(sentLog()).toEqual([])
    expect(acceptEntries()).toEqual([])
  })

  it.each([
    ['with no reason', {}],
    ['with a reason that is not text', { reason: 42 }],
    ['with a blank reason', { reason: '   ' }],
  ])('kicks nothing for an accept with a bad body, %s', async (_name, body) => {
    judgeCheck(file, taskId, 'worker-backend', 'hold')
    const response = await accept(body)
    expect(response.status).toBe(400)
    await deliveryIdle()
    expect(sentLog()).toEqual([])
    expect(acceptEntries()).toEqual([])
  })

  it('kicks nothing for an accept against a task id that is not a plain number', async () => {
    judgeCheck(file, taskId, 'worker-backend', 'hold')
    const response = await acceptResponse(post('/x', { reason: 'fine' }), '1; rm -rf', deps)
    expect(response.status).toBe(404)
    await deliveryIdle()
    expect(sentLog()).toEqual([])
    expect(acceptEntries()).toEqual([])
  })
})

describe('the thread picker', () => {
  it("lists the project's T3 threads, not the toolkit checkout's", async () => {
    const argvLog = join(scratch, 'list-argv.json')
    const listT3 = join(scratch, 'list-t3.mjs')
    writeFileSync(
      listT3,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write('[]')
`,
    )
    chmodSync(listT3, 0o755)
    const listed = await listThreads({ ...deps.config, t3: listT3, project: '/work/project' })
    expect(listed).toEqual({ ok: true, value: [] })
    expect(JSON.parse(readFileSync(argvLog, 'utf8'))).toEqual(['thread', 'list', '--project', '/work/project', '--json'])
  })
})
