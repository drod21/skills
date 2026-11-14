import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { batchSchema, runBatch, type JevClient } from './jev-batch.ts'
import { selectEvidence, selectionSchema } from './jev-select.ts'
import { nextUiStep, runUiFlow, uiSchema } from './jev-ui.ts'

const dirs: string[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-workflows-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function judge(answer: (id: string, request: Parameters<JevClient['systemOne']>[0]) => unknown): JevClient {
  return {
    systemOne: async (request) => ({
      answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, answer(id, request)])),
    }),
  }
}

it('batches questions without truncating input and retains raw responses', async () => {
  let calls = 0
  const input = batchSchema.assert({
    context: 'Shared goal',
    items: Array.from({ length: 30 }, (_, i) => ({
      id: `q${i}`,
      context: i === 0 ? 'Evidence observed. '.repeat(260) : 'Evidence',
      ask: { kind: 'yes_no', question: 'Relevant?' },
    })),
  })
  const client = judge((_id, request) => {
    if (calls++ === 0) expect(JSON.stringify(request.state)).toContain('Evidence observed. '.repeat(260))
    return { noul: 0.9 }
  })
  const results = await runBatch(input, directory(), client)
  expect(new Set(results.map((r) => r.receipt)).size).toBe(2)
  expect(results).toHaveLength(30)
  expect(results.every((r) => r.result.answer === 'yes')).toBe(true)
  expect(JSON.parse(readFileSync(results[0]!.receipt, 'utf8')).answers.q0.noul).toBe(0.9)
})

it('refuses secrets and duplicate IDs before any request', async () => {
  const input = batchSchema.assert({
    context: 'Goal',
    items: [{ id: 'q', context: 'ok', ask: { kind: 'yes_no', question: 'Relevant?' } }],
  })
  input.items.push(input.items[0]!)
  await expect(
    runBatch(
      input,
      directory(),
      judge(() => {
        throw new Error('must not call')
      }),
    ),
  ).rejects.toThrow('duplicate')
  input.items.pop()
  input.items[0]!.context = '-----BEGIN PRIVATE KEY-----'
  await expect(
    runBatch(
      input,
      directory(),
      judge(() => ({})),
    ),
  ).rejects.toThrow(/private key/)
  input.items[0]!.context = 'Safe text. '.repeat(363) + 'a person@example.com at a slice boundary'
  await expect(
    runBatch(
      input,
      directory(),
      judge(() => ({})),
    ),
  ).rejects.toThrow(/email/)
})

it('keeps pinned, missing, and uncertain sections and preserves source offsets', async () => {
  const input = selectionSchema.assert({
    mode: 'compact',
    goal: 'Preserve the decision',
    sections: [
      { id: 'constraint', source: 'thread', offset: 0, text: 'Never delete customer data', pinned: true },
      { id: 'routine', source: 'log', offset: 40, text: 'routine output' },
      { id: 'unknown', source: 'log', offset: 80, text: 'ambiguous output' },
    ],
  })
  const result = await selectEvidence(
    input,
    directory(),
    judge((id) => (id === 'section_1' ? { noul: 0.1 } : {})),
  )
  expect(result.outcome).toBe('hold')
  const artifact = JSON.parse(readFileSync(result.artifact, 'utf8'))
  expect(artifact.kept.map((s: { id: string }) => s.id)).toEqual(['constraint', 'unknown'])
  expect(artifact.toSummarize[0]).toMatchObject({ id: 'routine', source: 'log', offset: 40 })
})

it('splits long sections and rejects a summary losing a pinned constraint', async () => {
  const out = directory()
  const input = selectionSchema.assert({
    mode: 'compact',
    goal: 'Preserve constraints',
    summary: 'All done',
    sections: [
      { id: 'constraint', source: 'thread', offset: 10, text: 'Preserve this fact. '.repeat(360), pinned: true },
    ],
  })
  const result = await selectEvidence(
    input,
    out,
    judge(() => ({ noul: 0.1 })),
  )
  expect(result).toMatchObject({ verified: false, outcome: 'rejected', kept: 2 })
  const artifact = JSON.parse(readFileSync(result.artifact, 'utf8'))
  expect(artifact.kept.map((s: { offset: number }) => s.offset)).toEqual([10, 5010])
})

function pick(label: string, labels: string[]) {
  return {
    choice: label,
    confidence: 0.95,
    probabilities: Object.fromEntries(labels.map((id) => [id, id === label ? 0.95 : 0.01])),
  }
}
const observation = {
  surface: 'browser',
  identity: 'fixture-tab',
  state: 'Start screen',
  controls: [{ id: 'button-start', description: 'Start', action: 'click' }],
} as const
const uiClient = judge((id, request) => {
  const complete = JSON.stringify(request.state).includes('Success screen')
  return id === 'status'
    ? pick(complete ? 'complete' : 'continue', ['complete', 'continue', 'blocked', 'ambiguous'])
    : pick('control_0', ['control_0', 'stop'])
})

it('runs a bounded observe/choose/act/verify loop through adapter callbacks', async () => {
  let acted = 0
  const result = await runUiFlow(
    'Reach success',
    3,
    directory(),
    {
      observe: async () => ({ ...observation, state: acted ? 'Success screen' : 'Start screen' }),
      act: async (control) => {
        expect(control.id).toBe('button-start')
        acted++
      },
    },
    uiClient,
  )
  expect(result.status).toBe('complete')
  expect(acted).toBe(1)
})

it('stops unchanged state, budget exhaustion, and stale controls', async () => {
  const out = directory()
  const input = uiSchema.assert({ goal: 'Reach success', maxActions: 1, observation, history: [] })
  const first = await nextUiStep(input, out, uiClient)
  expect(first.status).toBe('action')
  expect((await nextUiStep({ ...input, history: first.history }, out, uiClient)).status).toBe('max_actions')
  expect((await nextUiStep({ ...input, maxActions: 3, history: first.history }, out, uiClient)).status).toBe('stuck')
  let reads = 0
  let acted = false
  const result = await runUiFlow(
    'Reach success',
    3,
    out,
    {
      observe: async () => ({ ...observation, state: ++reads > 1 ? 'Different screen' : 'Start screen' }),
      act: async () => {
        acted = true
      },
    },
    uiClient,
  )
  expect(result.status).toBe('stale')
  expect(acted).toBe(false)
})
