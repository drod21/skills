import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TypeSafeClient } from '@typesafe-ai/sdk'
import { describe, expect, it } from 'vitest'

import {
  allExecutors,
  availableFor,
  isTierRoute,
  LEGACY_TIER_ROUTES,
  parseAvailable,
  parseAvailableText,
  pickExecutor,
  TIER_EXECUTORS,
  TIER_ROUTES,
  verdictExecutor,
} from './jev-executors.lib.ts'
import { availabilityFlags, routeTasks } from './jev-route.ts'
import { EXECUTORS, type Answers } from './jev-route.lib.ts'

const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id)

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
      opus_patch: 'claudeAgent_2:claude-opus-5-5',
      fable_patch: 'claudeAgent_2:claude-fable-5-2',
    })
  })

  it('covers every dispatchable route the scope x subtlety table emits', () => {
    const emitted = new Set<string>(Object.values(EXECUTORS).flat())
    const current = TIER_ROUTES.filter((route) => !(LEGACY_TIER_ROUTES as readonly string[]).includes(route))
    expect(new Set<string>(current)).toEqual(emitted)
    for (const route of LEGACY_TIER_ROUTES) expect(emitted.has(route)).toBe(false)
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

  it('takes the tier default when it is available', () => {
    const picked = pickExecutor('sonnet_patch', offered)
    expect(picked).toMatchObject({ source: 'default', reasons: [] })
    expect(picked.executor?.id).toBe('claudeAgent_2:claude-sonnet-5-5')
  })

  it('takes the first available executor when the tier default is out', () => {
    const rest = offered.filter((entry) => entry.providerInstanceId !== 'claudeAgent_2')
    const picked = pickExecutor('sonnet_patch', rest)
    expect(picked.executor?.id).toBe(rest[0]?.id)
    expect(picked.source).toBe('default')
    expect(picked.reasons.join(' ')).toMatch(/tier default claudeAgent_2:claude-sonnet-5-5 is unavailable/)
  })

  it('returns no executor for an empty tier and says the lead picks', () => {
    const picked = pickExecutor('opus_patch', [])
    expect(picked.executor).toBeNull()
    expect(picked.source).toBeNull()
    expect(picked.reasons.join(' ')).toMatch(/no executor is available for opus_patch; the lead picks/)
    expect(verdictExecutor(picked)).toBeNull()
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

  const clientFor = (answers: Answers) => {
    const sent: { questions: Record<string, unknown> }[] = []
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => (sent.push(request), { answers }),
    } as unknown as Pick<TypeSafeClient, 'systemOne'>
    return { client, sent }
  }

  const sample = [{ title: 'Add the sessions field across packages', role: 'backend-worker' }]
  const quiet = { log: () => {}, exec: () => {} }

  it('makes one Jev call and stores the tier default on the verdict and the board', async () => {
    const execs: string[][] = []
    const { client, sent } = clientFor(full())
    const lines: string[] = []
    const [result] = await routeTasks(sample, client, {
      add: true,
      accept: 'The field exists',
      exec: (_script, args) => void execs.push(args),
      log: (line) => lines.push(line),
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.questions).not.toHaveProperty('executor')
    expect(result!.decision.route).toBe('sonnet_patch')
    expect(result!.verdict.executor).toEqual({
      id: 'claudeAgent_2:claude-sonnet-5-5',
      providerInstanceId: 'claudeAgent_2',
      model: 'claude-sonnet-5-5',
      options: { effort: 'high' },
      source: 'default',
    })
    expect(result!.verdict.answers).not.toHaveProperty('executor_pick')
    expect(JSON.parse(lines[0]!).executor).toEqual(result!.verdict.executor)
    const stored = JSON.parse(execs[0]![execs[0]!.indexOf('--jev') + 1]!)
    expect(stored.executor.id).toBe('claudeAgent_2:claude-sonnet-5-5')
  })

  it('honors --unavailable and --available', async () => {
    const { client } = clientFor(full())
    const [out] = await routeTasks(sample, client, { ...quiet, availability: { unavailable: ['claudeAgent_2'] } })
    expect(out!.verdict.executor).toMatchObject({ id: 'cursor:kimi-k3', source: 'default' })
    const available = parseAvailable(['claudeAgent_2:claude-sonnet-5-5'])
    const [single] = await routeTasks(sample, clientFor(full()).client, { ...quiet, availability: { available } })
    expect(single!.verdict.executor).toMatchObject({ id: 'claudeAgent_2:claude-sonnet-5-5', source: 'default' })
    const [none] = await routeTasks(sample, clientFor(full()).client, {
      ...quiet,
      availability: { available: parseAvailable(['codex:gpt-6-luna']) },
    })
    expect(none!.verdict.executor).toBeNull()
    expect(none!.verdict.reasons.join(' ')).toMatch(/no executor is available for sonnet_patch/)
  })

  it('stores no executor for a held route', async () => {
    const { client, sent } = clientFor(full({ risky: 0.95 }))
    const [result] = await routeTasks(sample, client, quiet)
    expect(result!.decision.route).toBe('needs_lead')
    expect(sent).toHaveLength(1)
    expect(result!.verdict.executor).toBeNull()
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
