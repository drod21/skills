import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TypeSafeClient } from '@typesafe-ai/sdk'
import { describe, expect, it } from 'vitest'

import {
  allExecutors,
  askExecutor,
  availableFor,
  buildPickRequest,
  isTierRoute,
  parseAvailable,
  parseAvailableText,
  pickExecutor,
  readChoice,
  TIER_EXECUTORS,
  TIER_ROUTES,
  verdictExecutor,
  type ChoiceAnswer,
  type TierRoute,
} from './jev-executors.lib.ts'
import { availabilityFlags, routeTasks } from './jev-route.ts'
import { EXECUTORS, THRESHOLDS, type Answers } from './jev-route.lib.ts'

const MIN = THRESHOLDS.minExecutorConfidence
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id)
const answer = (choice: string, confidence = 0.9): ChoiceAnswer => ({ choice, confidence })

describe('executor registry', () => {
  it('has unique ids, and an id repeated across tiers is the same executor', () => {
    const seen = new Map<string, unknown>()
    for (const list of Object.values(TIER_EXECUTORS)) {
      expect(new Set(ids(list)).size).toBe(list.length)
      for (const entry of list) {
        expect(entry.id).toBe(`${entry.providerInstanceId}:${entry.model}`)
        if (seen.has(entry.id)) expect(entry).toEqual(seen.get(entry.id))
        seen.set(entry.id, entry)
      }
    }
    expect(allExecutors()).toHaveLength(seen.size)
  })

  it('defaults every tier to the executor the coordinator skill mapped before', () => {
    const defaults = Object.fromEntries(TIER_ROUTES.map((route) => [route, TIER_EXECUTORS[route][0]?.id]))
    expect(defaults).toEqual({
      haiku_fork: 'claudeAgent_2:claude-haiku-5-5',
      luna_patch: 'codex:gpt-6-luna',
      grok_patch: 'cursor:grok-4.7',
      sonnet_patch: 'claudeAgent_2:claude-sonnet-5-5',
      terra_patch: 'codex:gpt-6.1-terra',
    })
  })

  it('covers every dispatchable route the scope x subtlety table emits', () => {
    const emitted = new Set<string>(Object.values(EXECUTORS).flat())
    expect(new Set<string>(TIER_ROUTES)).toEqual(emitted)
    for (const route of emitted) expect(isTierRoute(route)).toBe(true)
    expect(isTierRoute('needs_lead')).toBe(false)
    expect(isTierRoute('deterministic_script')).toBe(false)
  })

  it('states facts only: a price, a family, and code-specialized for the one name that says code', () => {
    for (const entry of allExecutors()) {
      expect(entry.facts.family.length).toBeGreaterThan(0)
      expect(entry.facts.costPerMtok).not.toBeNull()
      expect(Object.keys(entry.facts).sort()).toEqual(['codeSpecialized', 'costPerMtok', 'family'])
    }
    expect(
      allExecutors()
        .filter((entry) => entry.facts.codeSpecialized)
        .map((entry) => entry.id),
    ).toEqual(['cursor:kimi-k2.7-code', 'opencode:opencode/kimi-k2.7-code'])
  })

  it('keeps the curated OpenCode entries paid and on the OpenCode provider', () => {
    const opencode = allExecutors().filter((entry) => entry.providerInstanceId === 'opencode')
    expect(opencode.length).toBeGreaterThan(10)
    for (const entry of opencode) {
      expect(entry.model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/)
      expect(entry.model).not.toMatch(/free|preview|embed|audio|moderation/)
      expect(entry.facts.costPerMtok!.input).toBeGreaterThan(0)
    }
  })
})

describe('availability', () => {
  it('counts every registry entry when nothing is given', () => {
    for (const route of TIER_ROUTES) expect(availableFor(route)).toEqual(TIER_EXECUTORS[route])
  })

  it('keeps only offered pairs, in registry order', () => {
    const available = parseAvailable(['opencode:opencode/kimi-k3', 'claudeAgent_2:claude-sonnet-5-5'])
    expect(ids(availableFor('sonnet_patch', { available }))).toEqual([
      'claudeAgent_2:claude-sonnet-5-5',
      'opencode:opencode/kimi-k3',
    ])
    expect(availableFor('haiku_fork', { available })).toEqual([])
  })

  it('drops a whole provider or one model named in --unavailable', () => {
    expect(ids(availableFor('grok_patch', { unavailable: ['cursor'] }))).not.toContain('cursor:grok-4.7')
    expect(availableFor('grok_patch', { unavailable: ['cursor'] })).toEqual(
      TIER_EXECUTORS.grok_patch.filter((entry) => entry.providerInstanceId !== 'cursor'),
    )
    const oneModel = availableFor('grok_patch', { unavailable: ['opencode:opencode/kimi-k3'] })
    expect(ids(oneModel)).not.toContain('opencode:opencode/kimi-k3')
    expect(ids(oneModel)).toContain('opencode:console-xai/grok-4.7')
    const noOpencode = availableFor('sonnet_patch', { unavailable: ['opencode', 'cursor'] })
    expect(ids(noOpencode)).toEqual(['claudeAgent_2:claude-sonnet-5-5'])
  })

  it('applies --unavailable on top of --available', () => {
    const available = parseAvailable(['cursor:grok-4.7', 'grok:grok-4.7'])
    expect(ids(availableFor('grok_patch', { available, unavailable: ['cursor'] }))).toEqual(['grok:grok-4.7'])
  })

  it('reads strings, objects, and the harness catalog, skipping what cannot run', () => {
    const parsed = parseAvailable([
      'codex: gpt-6-luna',
      { providerInstanceId: 'cursor', model: 'grok-4.7' },
      { providerInstanceId: 'claudeAgent_2', canRun: true, models: [{ id: 'claude-haiku-5-5' }, 'claude-opus-5-5'] },
      { providerInstanceId: 'fx', canRun: false, models: [{ id: 'default' }] },
      { providerInstanceId: 'grok', model: 'grok-4.7', canRun: 'false', extra: true },
    ])
    expect([...parsed].sort()).toEqual([
      'claudeAgent_2:claude-haiku-5-5',
      'claudeAgent_2:claude-opus-5-5',
      'codex:gpt-6-luna',
    ])
    expect(
      parseAvailable({
        name: 'harness',
        capabilities: [{ providerInstanceId: 'codex', canRun: true, models: [{ id: 'gpt-6-luna', name: 'Luna' }] }],
      }),
    ).toEqual(new Set(['codex:gpt-6-luna']))
  })

  it('excludes a row unless canRun is boolean true', () => {
    const parsed = parseAvailable([
      { providerInstanceId: 'cursor', model: 'grok-4.7', canRun: 'false' },
      { providerInstanceId: 'grok', model: 'grok-4.7', canRun: 'true' },
      { providerInstanceId: 'codex', model: 'gpt-6-luna', canRun: true },
    ])
    expect([...parsed]).toEqual(['codex:gpt-6-luna'])
  })

  it('refuses a malformed --available list', () => {
    expect(() => parseAvailable('codex:gpt-6-luna')).toThrow(/JSON list/)
    expect(() => parseAvailable(['gpt-6-luna'])).toThrow(/valid entries/)
    expect(() => parseAvailable([{ model: 'x' }])).toThrow(/valid entries/)
    expect(() => parseAvailable([{ providerInstanceId: 'codex', models: 'x' }])).toThrow(/valid entries/)
    // A runnable row that names nothing to run is refused by the schema, not later.
    expect(() => parseAvailable([{ providerInstanceId: 'codex', canRun: true }])).toThrow(/valid entries/)
    expect(() => parseAvailable([{ providerInstanceId: 'codex', canRun: true, model: '  ', models: [] }])).toThrow(
      /valid entries/,
    )
    expect(parseAvailable([{ providerInstanceId: 'codex', canRun: false }])).toEqual(new Set())
  })
})

describe('pickExecutor', () => {
  const offered = TIER_EXECUTORS.sonnet_patch

  it('takes a confident pick among the offered executors', () => {
    const picked = pickExecutor('sonnet_patch', offered, answer('opencode:opencode/kimi-k3', 0.8), MIN)
    expect(picked.source).toBe('jev')
    expect(picked.executor?.id).toBe('opencode:opencode/kimi-k3')
  })

  it('takes the pick at exactly the floor', () => {
    expect(pickExecutor('sonnet_patch', offered, answer('opencode:opencode/kimi-k3', MIN), MIN).source).toBe('jev')
  })

  it('falls back to the tier default below the floor', () => {
    const picked = pickExecutor('sonnet_patch', offered, answer('opencode:opencode/kimi-k3', 0.3), MIN)
    expect(picked.source).toBe('default')
    expect(picked.executor?.id).toBe('claudeAgent_2:claude-sonnet-5-5')
    expect(picked.reasons.join(' ')).toMatch(/below floor/)
  })

  it('rejects a pick that was not offered', () => {
    const narrowed = offered.filter((entry) => entry.id !== 'opencode:opencode/kimi-k3')
    const wide = pickExecutor('sonnet_patch', narrowed, answer('opencode:opencode/kimi-k3'), MIN)
    expect(wide.source).toBe('default')
    expect(wide.executor?.id).toBe('claudeAgent_2:claude-sonnet-5-5')
    expect(wide.reasons.join(' ')).toMatch(/not offered/)
    // An id from another tier is not offered either.
    expect(pickExecutor('sonnet_patch', offered, answer('codex:gpt-6.1-terra'), MIN).source).toBe('default')
  })

  it('takes the first available executor when the tier default is out', () => {
    const rest = offered.filter((entry) => entry.providerInstanceId !== 'claudeAgent_2')
    const picked = pickExecutor('sonnet_patch', rest, null, MIN)
    expect(picked.executor?.id).toBe(rest[0]?.id)
    expect(picked.source).toBe('default')
    expect(picked.reasons.join(' ')).toMatch(/tier default claudeAgent_2:claude-sonnet-5-5 is unavailable/)
  })

  it('needs no answer for a single available executor', () => {
    const [only] = offered
    const picked = pickExecutor('sonnet_patch', [only!], null, MIN)
    expect(picked).toMatchObject({ source: 'default', reasons: [] })
    expect(picked.executor).toBe(only)
  })

  it('returns no executor for an empty tier and says the lead picks', () => {
    const picked = pickExecutor('terra_patch', [], answer('codex:gpt-6.1-terra'), MIN)
    expect(picked.executor).toBeNull()
    expect(picked.source).toBeNull()
    expect(picked.reasons.join(' ')).toMatch(/no executor is available for terra_patch; the lead picks/)
    expect(verdictExecutor(picked)).toBeNull()
  })

  it('reads only well-formed choice answers', () => {
    const id = offered[0]!.id
    expect(readChoice({ choice: id, confidence: 0.7, probabilities: { [id]: 0.7, secret: 0.2 } }, offered)).toEqual({
      choice: id,
      confidence: 0.7,
      probabilities: { [id]: 0.7 },
    })
    expect(readChoice({ choice: id, confidence: 0.7, apiKey: 'sk-test' }, offered)).toEqual({
      choice: id,
      confidence: 0.7,
    })
    expect(readChoice({ choice: 'secret', confidence: 0.9 }, offered)).toBeNull()
    expect(readChoice({ choice: id, confidence: 1.2 }, offered)).toBeNull()
    expect(readChoice({ choice: 3, confidence: 0.5 }, offered)).toBeNull()
    expect(readChoice(undefined, offered)).toBeNull()
  })
})

describe('askExecutor', () => {
  const clientReturning = (executor: unknown) => {
    const sent: { questions?: Record<string, unknown>; state?: Record<string, unknown> }[] = []
    const client = {
      systemOne: async (request: (typeof sent)[number]) => (sent.push(request), { answers: { executor } }),
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    return { client, sent }
  }
  const task = { title: 'Wire the new route', role: 'backend-worker', brief: 'Allowed: apps/server/src/x.ts' }

  it('asks once, offering only the available executors, and returns the raw answer', async () => {
    const offered = availableFor('sonnet_patch', { unavailable: ['opencode:opencode/mistral-large-4'] })
    const { client, sent } = clientReturning({ choice: 'opencode:opencode/kimi-k3', confidence: 0.9 })
    const result = await askExecutor(client, task, 'sonnet_patch', offered, MIN)
    expect(sent).toHaveLength(1)
    expect(result.pick.executor?.id).toBe('opencode:opencode/kimi-k3')
    expect(result.answer).toEqual({ choice: 'opencode:opencode/kimi-k3', confidence: 0.9 })
    const request = buildPickRequest(task, 'sonnet_patch', offered)
    expect(sent[0]).toEqual(request)
    expect(request.state.task).toEqual({ title: task.title, role: task.role, brief: task.brief })
    expect(request.state.tier.purpose).toMatch(/Several packages/)
    const json = JSON.stringify(request)
    expect(json).toContain('claudeAgent_2:claude-sonnet-5-5')
    expect(json).not.toContain('mistral-large-4')
    expect(json).toMatch(/\$3 in \/ \$15 out per million tokens/)
  })

  it('makes no call for zero or one available executor', async () => {
    const { client, sent } = clientReturning({ choice: 'x', confidence: 1 })
    const none = await askExecutor(client, task, 'terra_patch', [], MIN)
    const one = await askExecutor(client, task, 'terra_patch', availableFor('terra_patch').slice(0, 1), MIN)
    expect(sent).toHaveLength(0)
    expect(none.pick.executor).toBeNull()
    expect(one.pick.executor?.id).toBe('codex:gpt-6.1-terra')
    expect(one.answer).toBeNull()
  })

  it('falls back to the default on an unreadable answer', async () => {
    const { client } = clientReturning('nonsense')
    const result = await askExecutor(client, task, 'luna_patch', availableFor('luna_patch'), MIN)
    expect(result.pick).toMatchObject({ source: 'default' })
    expect(result.pick.executor?.id).toBe('codex:gpt-6-luna')
  })

  it('falls back when the choice answer is malformed and drops the payload', async () => {
    const { client } = clientReturning({
      choice: 3,
      confidence: 0.9,
      apiKey: 'sk-test',
      dangerouslySkipPermissions: true,
    })
    const result = await askExecutor(client, task, 'luna_patch', availableFor('luna_patch'), MIN)
    expect(result.answer).toBeNull()
    expect(result.pick.source).toBe('default')
    expect(result.pick.executor?.id).toBe('codex:gpt-6-luna')
    expect(JSON.stringify(result)).not.toContain('sk-test')
    expect(JSON.stringify(result)).not.toContain('dangerouslySkipPermissions')
  })

  it('falls back to the default, and says why, when the call throws', async () => {
    const client = {
      systemOne: async () => {
        throw new Error('503 overloaded')
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    const result = await askExecutor(client, task, 'luna_patch', availableFor('luna_patch'), MIN)
    expect(result.pick.executor?.id).toBe('codex:gpt-6-luna')
    expect(result.pick.reasons.join(' ')).toMatch(/executor pick failed/)
  })
})

describe('executor in routed verdicts', () => {
  // Scope 2 and subtlety 0 route to sonnet_patch; a high risky noul holds the task.
  const full = (over: { risky?: number } = {}): Answers => {
    const level = (score: number) => ({
      score,
      confidence: 0.9,
      probabilities: { '0': score === 0 ? 1 : 0, '1': score === 1 ? 1 : 0, '2': score === 2 ? 1 : 0 },
    })
    return {
      is_mechanical: { noul: 0.1 },
      scope: level(2),
      subtlety: level(0),
      risky: { noul: over.risky ?? 0.05 },
      needs_decision: { noul: 0.05 },
      role_fits: { noul: 0.95 },
      owner: { choice: 'backend-worker', confidence: 0.9 },
      check: { choice: 'typecheck', confidence: 0.8 },
    }
  }

  const clientFor = (answers: Answers, pick: unknown) => {
    let calls = 0
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => {
        calls += 1
        return 'executor' in request.questions ? { answers: { executor: pick } } : { answers }
      },
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    return { client, calls: () => calls }
  }

  const sample = [{ title: 'Add the sessions field across packages', role: 'backend-worker' }]
  const quiet = { log: () => {}, exec: () => {} }

  it('adds the picked executor and the raw answer to the verdict, and passes it to the board', async () => {
    const execs: string[][] = []
    const { client, calls } = clientFor(full(), { choice: 'opencode:opencode/kimi-k3', confidence: 0.8 })
    const lines: string[] = []
    const [result] = await routeTasks(sample, client, {
      add: true,
      accept: 'The field exists',
      exec: (_script, args) => void execs.push(args),
      log: (line) => lines.push(line),
    })
    expect(calls()).toBe(2)
    expect(result!.decision.route).toBe('sonnet_patch')
    expect(result!.verdict.executor).toEqual({
      id: 'opencode:opencode/kimi-k3',
      providerInstanceId: 'opencode',
      model: 'opencode/kimi-k3',
      options: {},
      source: 'jev',
    })
    expect(result!.verdict.answers).toMatchObject({
      executor_pick: { choice: 'opencode:opencode/kimi-k3', confidence: 0.8 },
    })
    expect(JSON.parse(lines[0]!).executor).toEqual(result!.verdict.executor)
    const stored = JSON.parse(execs[0]![execs[0]!.indexOf('--jev') + 1]!)
    expect(stored.executor.id).toBe('opencode:opencode/kimi-k3')
    expect(stored.reasons.join(' ')).toMatch(/Jev picked opencode:opencode\/kimi-k3/)
    expect(JSON.stringify(stored.answers).length).toBeLessThan(16_000)
  })

  it('uses the tier default on a low-confidence pick', async () => {
    const { client } = clientFor(full(), { choice: 'opencode:opencode/kimi-k3', confidence: 0.2 })
    const [result] = await routeTasks(sample, client, quiet)
    expect(result!.verdict.executor).toMatchObject({ id: 'claudeAgent_2:claude-sonnet-5-5', source: 'default' })
  })

  it('never emits or stores untrusted choice text or probability keys', async () => {
    const secret = 'synthetic-secret-1165'
    for (const pick of [
      { choice: secret, confidence: 0.9 },
      { choice: 'opencode:opencode/kimi-k3', confidence: 0.9, probabilities: { [secret]: 0.7 } },
    ]) {
      const lines: string[] = []
      const execs: string[][] = []
      const { client } = clientFor(full(), pick)
      const result = await routeTasks(sample, client, {
        add: true,
        accept: 'Field exists',
        log: (line) => lines.push(line),
        exec: (_script, args) => void execs.push(args),
      })
      expect(JSON.stringify({ result, lines, execs })).not.toContain(secret)
    }
  })

  it('honors --unavailable and --available before asking', async () => {
    const { client } = clientFor(full(), { choice: 'claudeAgent_2:claude-sonnet-5-5', confidence: 0.99 })
    const [out] = await routeTasks(sample, client, { ...quiet, availability: { unavailable: ['claudeAgent_2'] } })
    // Jev named an executor that was filtered out, so the first available one stands.
    expect(out!.verdict.executor).toMatchObject({ id: 'cursor:kimi-k3', source: 'default' })
    const available = parseAvailable(['claudeAgent_2:claude-sonnet-5-5'])
    const only = clientFor(full(), { choice: 'x', confidence: 1 })
    const [single] = await routeTasks(sample, only.client, { ...quiet, availability: { available } })
    expect(only.calls()).toBe(1)
    expect(single!.verdict.executor).toMatchObject({ id: 'claudeAgent_2:claude-sonnet-5-5', source: 'default' })
    const empty = clientFor(full(), { choice: 'x', confidence: 1 })
    const [none] = await routeTasks(sample, empty.client, {
      ...quiet,
      availability: { available: parseAvailable(['codex:gpt-6-luna']) },
    })
    expect(none!.verdict.executor).toBeNull()
    expect(none!.verdict.reasons.join(' ')).toMatch(/no executor is available for sonnet_patch/)
  })

  it('asks no executor question for a held route', async () => {
    const { client, calls } = clientFor(full({ risky: 0.95 }), { choice: 'x', confidence: 1 })
    const [result] = await routeTasks(sample, client, quiet)
    expect(result!.decision.route).toBe('needs_lead')
    expect(calls()).toBe(1)
    expect(result!.verdict.executor).toBeNull()
    expect(result!.verdict.answers).not.toHaveProperty('executor_pick')
  })

  it.each(TIER_ROUTES)('has an executor question for %s', (route: TierRoute) => {
    expect(Object.keys(buildPickRequest({ title: 't', role: 'r' }, route, TIER_EXECUTORS[route]).questions)).toEqual([
      'executor',
    ])
  })
})

describe('availability flags', () => {
  const fileWith = (content: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'jev-available-')), 'available.json')
    writeFileSync(file, content)
    return file
  }

  it('is absent without either flag', () => {
    expect(availabilityFlags(['Fix a typo', '--role', 'ux-worker'])).toBeUndefined()
  })

  it('reads the file and every repeated --unavailable', () => {
    const file = fileWith(JSON.stringify(['codex:gpt-6-luna']))
    const flags = availabilityFlags([
      'x',
      '--available',
      file,
      '--unavailable',
      'cursor',
      '--unavailable',
      'grok:grok-4.7',
    ])
    expect(flags?.available).toEqual(new Set(['codex:gpt-6-luna']))
    expect(flags?.unavailable).toEqual(['cursor', 'grok:grok-4.7'])
    expect(availabilityFlags(['x', '--unavailable', 'cursor'])).toEqual({ unavailable: ['cursor'] })
  })

  it('refuses a missing value, an unreadable file, and a bad list', () => {
    expect(() => availabilityFlags(['x', '--unavailable'])).toThrow(/--unavailable needs/)
    expect(() => availabilityFlags(['x', '--unavailable', '--add'])).toThrow(/--unavailable needs/)
    expect(() => availabilityFlags(['x', '--available'])).toThrow(/--available needs a text value/)
    expect(() => availabilityFlags(['x', '--available', fileWith('not json')])).toThrow(/not readable JSON/)
    expect(() => availabilityFlags(['x', '--available', fileWith('{}')])).toThrow(/JSON list/)
    expect(() => parseAvailableText('{')).toThrow(/not readable JSON/)
    expect(() => parseAvailableText('{"capabilities":{"models":"no"}}')).toThrow(/--available/)
  })

  it('never echoes malformed file content or a file path', () => {
    const secret = 'synthetic-secret-1165'
    for (const input of [fileWith(`{"${secret}`), `/missing/${secret}`]) {
      try {
        availabilityFlags(['x', '--available', input])
      } catch (error) {
        expect(String(error)).not.toContain(secret)
      }
    }
  })
})
