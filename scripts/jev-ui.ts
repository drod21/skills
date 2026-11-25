import './jev-node-only.mjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import * as z from 'zod'

import { hashRequest } from './jev-ask.lib.ts'
import { launchJevCli, readJevInput, runBatch, type JevClient } from './jev-batch.ts'

const bounded = (max: number) => z.string().min(1).max(max)
const control = z.object({ id: bounded(100), description: bounded(500), action: bounded(500) })
const observationSchema = z.object({
  surface: z.enum(['browser', 'simulator', 'emulator']),
  identity: bounded(500),
  state: bounded(5000),
  controls: z.array(control).max(3),
})
const historySchema = z.array(z.object({ fingerprint: z.string(), control, receipt: z.string() }))
export const uiSchema = z.object({
  goal: bounded(3000),
  maxActions: z.number().int().min(1).max(50),
  observation: observationSchema,
  history: historySchema,
})
export type UiInput = z.infer<typeof uiSchema>
export type UiObservation = z.infer<typeof observationSchema>
type Control = z.infer<typeof control>
type TerminalStatus = 'complete' | 'blocked' | 'ambiguous' | 'hold' | 'max_actions' | 'stuck' | 'stale'
type UiBase = { history: UiInput['history']; observation: UiObservation; receipt: string | null }
export type UiStep = UiBase & ({ status: TerminalStatus } | { status: 'action'; action: Control; fingerprint: string })

function stopReason(input: UiInput, fingerprint: string) {
  if (input.history.length >= input.maxActions) return 'max_actions'
  if (input.history.at(-1)?.fingerprint === fingerprint) return 'stuck'
  if (!input.observation.controls.length) return 'blocked'
  return null
}

async function chooseControl(input: UiInput, context: string, out: string, client?: JevClient) {
  const labels = Object.fromEntries(
    input.observation.controls.map((control, i) => [`control_${i}`, `${control.description}: ${control.action}`]),
  )
  labels.stop = 'No supplied action is appropriate or sufficiently grounded'
  const results = await runBatch(
    {
      context,
      items: [
        {
          id: 'target',
          context: '',
          ask: {
            kind: 'pick',
            question: 'Which observed control and supplied action advances the goal?',
            labels,
          },
        },
      ],
    },
    out,
    client,
  )
  const selected = results[0]!
  const index = Number(selected.result.answer?.replace('control_', ''))
  return { selected, control: input.observation.controls[index] }
}

export async function nextUiStep(raw: unknown, out: string, client?: JevClient): Promise<UiStep> {
  const input = uiSchema.parse(raw)
  const fingerprint = hashRequest(input.observation)
  const context = JSON.stringify({ goal: input.goal, observation: input.observation, recent: input.history.slice(-3) })
  if (context.length > 12000) throw new Error('UI state exceeds the request budget; narrow the observation')
  const ids = input.observation.controls.map((control) => control.id)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate observed control ID')
  const items = [
    {
      id: 'status',
      context: '',
      ask: {
        kind: 'pick' as const,
        question:
          'Which state best describes the observed goal? A completion claim must be visible in the current evidence.',
        labels: {
          complete: 'Goal visibly met',
          continue: 'A next action is available',
          blocked: 'Error, barrier, or missing evidence',
          ambiguous: 'Unclear goal state',
        },
      },
    },
  ]
  const results = await runBatch({ context, items }, out, client)
  const status = results[0]!
  const finish = (status: TerminalStatus, receipt: string | null): UiStep => ({
    status,
    receipt,
    history: input.history,
    observation: input.observation,
  })
  if (status.result.outcome === 'hold') return finish('hold', status.receipt)
  const state = z.enum(['complete', 'continue', 'blocked', 'ambiguous']).parse(status.result.answer)
  if (state !== 'continue') return finish(state, status.receipt)
  const stop = stopReason(input, fingerprint)
  if (stop) return finish(stop, status.receipt)
  const { selected, control } = await chooseControl(input, context, out, client)
  if (selected.result.outcome === 'hold') return finish('hold', selected.receipt)
  if (!control) return finish('ambiguous', selected.receipt)
  return {
    status: 'action',
    receipt: selected.receipt,
    observation: input.observation,
    action: control,
    fingerprint,
    history: [...input.history, { fingerprint, control, receipt: selected.receipt }],
  }
}

export async function runUiFlow(
  goal: string,
  maxActions: number,
  out: string,
  adapter: { observe: () => Promise<unknown>; act: (control: Control, observation: UiObservation) => Promise<void> },
  client?: JevClient,
) {
  let history: UiInput['history'] = []
  for (;;) {
    const observation = observationSchema.parse(await adapter.observe())
    const next = await nextUiStep({ goal, maxActions, observation, history }, out, client)
    if (next.status !== 'action') return next
    const current = observationSchema.parse(await adapter.observe())
    if (hashRequest(current) !== next.fingerprint) return { ...next, status: 'stale' }
    await adapter.act(next.action, observation)
    history = next.history
  }
}

export async function uiMain(argv = process.argv.slice(2), client?: JevClient) {
  const [file, flag, out] = argv
  if (!file || flag !== '--out' || !out || argv.length !== 3)
    throw new Error('usage: node scripts/jev-ui.ts observation.json --out artifact-directory')
  const result = await nextUiStep(readJevInput(file, (value) => uiSchema.parse(value)), out, client)
  const artifact = join(resolve(out), `ui-${randomUUID()}.json`)
  writeFileSync(artifact, JSON.stringify(result, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ ...result, artifact }))
  return result.status === 'action' || result.status === 'complete' ? 0 : 3
}

launchJevCli(import.meta.url, uiMain)
