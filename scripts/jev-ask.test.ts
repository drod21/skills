import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { main } from './jev-ask.ts'
import { readAsk, readCheck, type Ask } from './jev-ask.lib.ts'

const yesNo: Ask = { kind: 'yes_no', question: 'Is the label whole?' }
const pick: Ask = { kind: 'pick', question: 'Which fix?', labels: { alpha: 'alpha', beta: 'beta' } }

function noul(p: number) {
  return { answer: { noul: p } }
}

function choice(choiceLabel: string, confidence: number, alpha: number, beta: number) {
  return { pick: { choice: choiceLabel, confidence, probabilities: { alpha, beta } } }
}

describe('readAsk and readCheck', () => {
  it('maps yes/no and pick boundaries, and holds a malformed answer', () => {
    expect(readAsk(yesNo, noul(0.7))).toMatchObject({ outcome: 'answered', answer: 'yes' })
    expect(readAsk(yesNo, noul(0.69)).outcome).toBe('hold')
    expect(readAsk(yesNo, noul(0.3))).toMatchObject({ outcome: 'answered', answer: 'no' })
    expect(readAsk(yesNo, noul(0.31)).outcome).toBe('hold')
    expect(readAsk(yesNo, {}).reasons[0]).toMatch(/malformed/)

    expect(readAsk(pick, choice('alpha', 0.5, 0.25, 0.1))).toMatchObject({ outcome: 'answered', answer: 'alpha' })
    expect(readAsk(pick, choice('alpha', 0.49, 0.8, 0.2)).outcome).toBe('hold')
    expect(readAsk(pick, choice('alpha', 0.9, 0.57, 0.43)).reasons.join(' ')).toMatch(/margin/)
    expect(readAsk(pick, { pick: { choice: 'nope', confidence: 0.9 } }).outcome).toBe('hold')

    expect(readCheck({ fits: { noul: 0.7 }, gap: gap('fits', 0.8) })).toMatchObject({
      outcome: 'confirmed',
      gap: 'fits',
    })
    expect(readCheck({ fits: { noul: 0.7 }, gap: gap('incomplete', 0.8) }).outcome).toBe('hold')
    expect(readCheck({ fits: { noul: 0.3 }, gap: gap('fits', 0.8) }).outcome).toBe('rejected')
    expect(readCheck({ fits: { noul: 0.9 }, gap: gap('failing', 0.8) }).outcome).toBe('rejected')
    expect(readCheck({ fits: { noul: 0.31 }, gap: gap('failing', 0.4) }).outcome).toBe('rejected')
    expect(readCheck({ fits: { noul: 'nope' } })).toMatchObject({ outcome: 'hold' })
  })
})

function pngHeader(width: number, height: number) {
  const bytes = Buffer.alloc(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpegHeader(width: number, height: number) {
  const comment = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x00, 0x00])
  const frame = Buffer.alloc(9)
  frame[0] = 0xff
  frame[1] = 0xc0
  frame.writeUInt16BE(7, 2)
  frame[4] = 8
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  return Buffer.concat([comment, frame])
}

function gap(choiceLabel: string, confidence: number) {
  const probabilities = { fits: 0, incomplete: 0, other_check: 0, failing: 0, [choiceLabel]: 0.7 }
  return { choice: choiceLabel, confidence, probabilities }
}

// Each case spawns several team-tasks.mjs processes; a loaded CI runner takes over the 5s default.
describe('jev-ask CLI', { timeout: 60_000 }, () => {
  const dirs: string[] = []
  const previous = process.env.TEAM_TASKS_FILE

  afterEach(() => {
    if (previous === undefined) delete process.env.TEAM_TASKS_FILE
    else process.env.TEAM_TASKS_FILE = previous
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function board() {
    const dir = mkdtempSync(join(tmpdir(), 'jev-ask-'))
    dirs.push(dir)
    const file = join(dir, 'tasks.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 1,
            role: 'qa-worker',
            title: 'Check the label',
            status: 'claimed',
            owner: 'qa-1',
            after: [],
            route: 'haiku_fork',
            accept: 'the label is whole',
            evidence: [],
          },
        ],
      }),
    )
    process.env.TEAM_TASKS_FILE = file
    return file
  }

  function capture() {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    return {
      log,
      error,
      restore() {
        log.mockRestore()
        error.mockRestore()
      },
    }
  }

  it('prints one JSON line, replays a cache hit without calling Jev, and records a hold when Jev is down', async () => {
    const file = board()
    const calls: unknown[] = []
    const client = {
      systemOne: async (request: unknown) => {
        calls.push(request)
        return { answers: noul(0.86) }
      },
    }
    const output = capture()
    try {
      const code = await main(['--yes-no', 'Is the label whole?', '--task', '1', '--by', 'qa-1'], { client })
      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect(output.log).toHaveBeenCalledTimes(1)
      const line = String(output.log.mock.calls[0]?.[0])
      expect(line).not.toContain('\n')
      expect(JSON.parse(line)).toMatchObject({ outcome: 'answered', answer: 'yes' })

      const again = await main(['--yes-no', 'Is the label whole?', '--task', '1', '--by', 'qa-1'], { client })
      expect(again).toBe(0)
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(output.log.mock.calls[1]?.[0]))).toMatchObject({ cached: true, answer: 'yes' })

      const down = {
        systemOne: async () => {
          throw new Error('network down')
        },
      }
      const failed = await main(['--yes-no', 'A different question?', '--task', '1', '--by', 'qa-1'], { client: down })
      expect(failed).toBe(1)
      const tasks = JSON.parse(readFileSync(file, 'utf8')).tasks
      const hold = tasks[0].decisions.at(-1)
      expect(hold).toMatchObject({ tool: 'ask', outcome: 'hold' })
      expect(hold.reasons[0]).toMatch(/^unavailable: /)
      expect(String(output.log.mock.calls.at(-1)?.[0])).not.toContain('\n')
    } finally {
      output.restore()
    }
  })

  function judgments(file: string) {
    const [task] = JSON.parse(readFileSync(file, 'utf8')).tasks
    return (task.decisions ?? []).filter((entry: { kind: string }) => entry.kind === 'judgment')
  }

  it('retains the service model and leaves missing or historical model identity unknown', async () => {
    board()
    const output = capture()
    const client = { systemOne: vi.fn(async () => ({ answers: noul(0.9), model: 'jev-fixture-r17' })) }
    const args = ['--yes-no', 'Is the label whole?', '--task', '1', '--by', 'qa-1']
    const receipt = () => String(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).receipt)
    try {
      expect(await main(args, { client })).toBe(0)
      const original = JSON.parse(readFileSync(receipt(), 'utf8'))
      expect(original.model).toBe('jev-fixture-r17')
      const { model: _model, ...legacy } = original
      writeFileSync(receipt(), JSON.stringify(legacy))
      expect(await main(args, { client })).toBe(0)
      expect(client.systemOne).toHaveBeenCalledTimes(1)
      expect(JSON.parse(readFileSync(receipt(), 'utf8'))).not.toHaveProperty('model')
      expect(
        await main(['--yes-no', 'Another question?', '--task', '1', '--by', 'qa-1'], {
          client: { systemOne: async () => ({ answers: noul(0.9) }) },
        }),
      ).toBe(0)
      expect(JSON.parse(readFileSync(receipt(), 'utf8')).model).toBeNull()
      expect(
        await main(['--yes-no', 'Unavailable question?', '--task', '1', '--by', 'qa-1'], {
          client: {
            systemOne: async () => {
              throw new Error('fixture unavailable')
            },
          },
        }),
      ).toBe(1)
      expect(JSON.parse(readFileSync(receipt(), 'utf8')).model).toBeNull()
    } finally {
      output.restore()
    }
  })

  function retain(file: string, name: string, text: string | Uint8Array) {
    const path = join(mkdtempSync(join(file, '..', 'source-')), name)
    writeFileSync(path, text)
    execFileSync(process.execPath, [join(import.meta.dirname, 'team-tasks.mjs'), 'evidence', '1', path], {
      stdio: 'pipe',
    })
    return JSON.parse(readFileSync(file, 'utf8')).tasks[0].evidence.at(-1) as string
  }

  function checkArgs(phase: string, refs: string[]) {
    return [
      '--check-evidence',
      '--summary',
      'Acceptance checkpoint',
      '--task',
      '1',
      '--by',
      'qa-1',
      '--phase',
      phase,
      ...refs.flatMap((ref) => ['--current-evidence', ref]),
    ]
  }

  it.each([false, true])(
    'separates old BLOCKED/no PR history from current merged proof (reversed=%s)',
    async (reverse) => {
      const file = board()
      // Same basename, distinct retained full paths: a filename cannot identify authority.
      const blocked = 'BLOCKED/no PR. No label proof yet.'
      const merged = 'Merged PR. Tests passed; the label is whole.'
      const first = retain(file, 'report.txt', reverse ? merged : blocked)
      const second = retain(file, 'report.txt', reverse ? blocked : merged)
      const current = reverse ? first : second
      const historical = reverse ? second : first
      const client = {
        systemOne: vi.fn(async (request: unknown) => {
          expect(request).toMatchObject({
            state: {
              phase: 'merged acceptance',
              currentEvidence: [{ ref: current, excerpt: merged }],
              historicalEvidence: [{ ref: historical, excerpt: blocked }],
            },
          })
          expect(JSON.stringify(request)).toContain('declarations, not proof')
          return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
        }),
      }
      const output = capture()
      try {
        const args = checkArgs('merged acceptance', [current])
        expect(await main(args, { client })).toBe(0)
        const line = JSON.parse(String(output.log.mock.calls.at(-1)?.[0]))
        const receipt = JSON.parse(readFileSync(line.receipt, 'utf8'))
        expect(receipt.request).toEqual(client.systemOne.mock.calls[0]?.[0])
        expect(judgments(file).at(-1)).toMatchObject({ outcome: 'confirmed', evidence: [first, second] })
        expect(await main(args, { client })).toBe(0)
        expect(client.systemOne).toHaveBeenCalledTimes(1)
        expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).cached).toBe(true)
        expect(
          await main(checkArgs('release acceptance', [current]), {
            client: {
              systemOne: async () => ({ answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }),
            },
          }),
        ).toBe(0)
        expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).requestHash).not.toBe(line.requestHash)
        const rejecting = {
          systemOne: async (request: unknown) => {
            expect(request).toMatchObject({
              state: { currentEvidence: [{ excerpt: blocked }], historicalEvidence: [{ excerpt: merged }] },
            })
            return { answers: { fits: { noul: 0.1 }, gap: gap('failing', 0.8) } }
          },
        }
        expect(await main(checkArgs('merged acceptance', [historical]), { client: rejecting })).toBe(2)
        expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).requestHash).not.toBe(line.requestHash)
        const explained = String(output.error.mock.calls.at(-1)?.[0])
        expect(explained).toContain('gap failing')
        expect(explained).toContain('Accept: the label is whole')
        expect(explained).toContain(`${historical} [current] (excerpt)`)
        expect(explained).toContain(`${current} [historical] (excerpt)`)
        const script = join(import.meta.dirname, 'team-tasks.mjs')
        expect(spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1']).status).toBe(1)
        expect(await main(args, { client })).toBe(0)
        expect(spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1']).status).toBe(0)
      } finally {
        output.restore()
      }
    },
  )

  it('prioritizes current evidence beyond the old item cap and retains historical omissions', async () => {
    const file = board()
    for (let index = 0; index < 12; index++) retain(file, `old-${index}.txt`, `History ${index}`)
    const current = retain(file, 'current.txt', 'Current label proof')
    const output = capture()
    try {
      expect(
        await main(checkArgs('acceptance', [current]), {
          client: {
            systemOne: async (request: unknown) => {
              expect(request).toMatchObject({
                state: { currentEvidence: [{ ref: current, excerpt: 'Current label proof' }] },
              })
              const state = (request as { state: { historicalEvidence: unknown[] } }).state
              expect(state.historicalEvidence).toHaveLength(12)
              expect(state.historicalEvidence.at(-1)).toMatchObject({ sent: false, why: 'over the evidence item cap' })
              return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
            },
          },
        }),
      ).toBe(0)
    } finally {
      output.restore()
    }
  })

  it('refuses missing, unknown, unreadable, guarded, and over-cap current selections before calling Jev', async () => {
    const file = board()
    const refs = Array.from({ length: 13 }, (_, index) => retain(file, `proof-${index}.txt`, `Proof ${index}`))
    const secret = retain(file, 'secret.txt', '-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----')
    const client = { systemOne: vi.fn(async () => ({ answers: noul(0.9) })) }
    const output = capture()
    try {
      const cases = [
        checkArgs('acceptance', []),
        [...checkArgs('acceptance', [refs[0]!]).filter((value) => value !== '--phase' && value !== 'acceptance')],
        checkArgs('acceptance', ['proof-0.txt']),
        checkArgs('acceptance', [join(file, '..', 'unknown.txt')]),
        checkArgs('acceptance', refs),
        checkArgs('acceptance', [secret]),
        ['--yes-no', 'Fine?', '--phase', 'acceptance', '--current-evidence', refs[0]!],
        checkArgs('someone@example.com', [refs[0]!]),
      ]
      for (const args of cases) expect(await main(args, { client }), args.join(' ')).toBe(1)
      rmSync(refs[0]!)
      expect(await main(checkArgs('acceptance', [refs[0]!]), { client })).toBe(1)
      expect(client.systemOne).not.toHaveBeenCalled()
      expect(judgments(file)).toEqual([])
    } finally {
      output.restore()
    }
  })

  it('refuses five selected images instead of silently dropping current proof', async () => {
    const file = board()
    const png = pngHeader(390, 844)
    const refs = Array.from({ length: 5 }, (_, index) => retain(file, `shot-${index}.png`, png))
    const client = { systemOne: vi.fn(async () => ({ answers: noul(0.9) })) }
    const output = capture()
    try {
      expect(await main(checkArgs('acceptance', refs), { client })).toBe(1)
      expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error).toContain('over the image cap')
      expect(client.systemOne).not.toHaveBeenCalled()
      expect(judgments(file)).toEqual([])
    } finally {
      output.restore()
    }
  })

  it('journals a cache replay again, so a later choice or release does not strand the worker', async () => {
    const file = board()
    const client = { systemOne: async () => ({ answers: noul(0.9) }) }
    const output = capture()
    try {
      const args = ['--yes-no', 'Is the label whole?', '--task', '1', '--by', 'qa-1']
      expect(await main(args, { client })).toBe(0)
      expect(await main(args, { client })).toBe(0)
      const recorded = judgments(file)
      expect(recorded).toHaveLength(2)
      expect(recorded[1]).toMatchObject({ outcome: 'answered', answer: 'yes', requestHash: recorded[0].requestHash })
    } finally {
      output.restore()
    }
  })

  it('confirms evidence and lets done through, and blocks done before the check', async () => {
    const file = board()
    const dir = dirs[0] ?? tmpdir()
    const log = join(dir, 'focused.txt')
    writeFileSync(log, 'Tests 12 passed. The label renders whole at every text size.')
    const script = join(import.meta.dirname, 'team-tasks.mjs')
    const env = { ...process.env, TEAM_TASKS_FILE: file }
    execFileSync(process.execPath, [script, 'evidence', '1', log], { env, stdio: 'pipe' })
    const early = spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1'], { env, encoding: 'utf8' })
    expect(early.status).toBe(1)
    expect(early.stderr).toContain('NeverDoneUnconfirmed')

    const sent: unknown[] = []
    const client = {
      systemOne: async (request: unknown) => {
        sent.push(request)
        return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
      },
    }
    const output = capture()
    try {
      const preflight = await main(
        ['--check-evidence', '--preflight', '--summary', 'Focused suite passes', '--task', '1', '--by', 'qa-1'],
        { client },
      )
      expect(preflight).toBe(0)
      expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0]))).toMatchObject({
        outcome: 'preflight_ready',
        evidence: [expect.stringContaining('focused.txt')],
      })
      expect(sent).toHaveLength(0)
      const stillBlocked = spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1'], {
        env,
        encoding: 'utf8',
      })
      expect(stillBlocked.stderr).toContain('NeverDoneUnconfirmed')
      const code = await main(
        ['--check-evidence', '--summary', 'Focused suite passes', '--task', '1', '--by', 'qa-1'],
        {
          client,
        },
      )
      expect(code).toBe(0)
    } finally {
      output.restore()
    }
    expect(JSON.stringify(sent[0])).toContain('The label renders whole')
    const done = spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1'], { env, encoding: 'utf8' })
    expect(done.status, done.stderr).toBe(0)
  })

  it('does not record a check when the lead decides while Jev is answering, so done stays blocked', async () => {
    const file = board()
    const dir = dirs[0] ?? tmpdir()
    const log = join(dir, 'focused.txt')
    writeFileSync(log, 'Tests 12 passed. The label renders whole at every text size.')
    const script = join(import.meta.dirname, 'team-tasks.mjs')
    const env = { ...process.env, TEAM_TASKS_FILE: file }
    execFileSync(process.execPath, [script, 'evidence', '1', log], { env, stdio: 'pipe' })
    // The lead's choice lands after jev-ask read the task and before its answer is written.
    const client = {
      systemOne: async () => {
        execFileSync(process.execPath, [script, 'decide', '1', '--summary', 'Use the new layout', '--by', 'lead'], {
          env,
          stdio: 'pipe',
        })
        return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
      },
    }
    const output = capture()
    try {
      const args = ['--check-evidence', '--summary', 'Focused suite passes', '--task', '1', '--by', 'qa-1']
      expect(await main(args, { client })).toBe(1)
      expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error).toMatch(/while the check ran/)
    } finally {
      output.restore()
    }
    expect(judgments(file)).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).tasks[0].pendingChecks).toBeUndefined()
    const done = spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1'], { env, encoding: 'utf8' })
    expect(done.status).toBe(1)
    expect(done.stderr).toContain('NeverDoneUnconfirmed')
  })

  it('blocks done during a second check and settles a rejected answer', async () => {
    const file = board()
    const log = join(dirs[0] ?? tmpdir(), 'focused.txt')
    writeFileSync(log, 'Tests passed.')
    const script = join(import.meta.dirname, 'team-tasks.mjs')
    const env = { ...process.env, TEAM_TASKS_FILE: file }
    execFileSync(process.execPath, [script, 'evidence', '1', log], { env, stdio: 'pipe' })
    const args = ['--check-evidence', '--summary', 'first check', '--task', '1', '--by', 'qa-1']
    const output = capture()
    try {
      expect(
        await main(args, {
          client: { systemOne: async () => ({ answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }) },
        }),
      ).toBe(0)
      const client = {
        systemOne: async () => {
          const done = spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1'], { env, encoding: 'utf8' })
          expect(done.status).toBe(1)
          expect(done.stderr).toContain('NeverDoneWhileAskingJev')
          const nested = await main(
            ['--check-evidence', '--summary', 'parallel check', '--task', '1', '--by', 'qa-1'],
            {
              client: {
                systemOne: async () => {
                  throw new Error('must not call Jev')
                },
              },
            },
          )
          expect(nested).toBe(1)
          return { answers: { fits: { noul: 0.1 }, gap: gap('failing', 0.8) } }
        },
      }
      expect(
        await main(['--check-evidence', '--summary', 'second check', '--task', '1', '--by', 'qa-1'], { client }),
      ).toBe(2)
      const done = spawnSync(process.execPath, [script, 'done', '1', '--owner', 'qa-1'], { env, encoding: 'utf8' })
      expect(done.stderr).toContain('NeverDoneUnconfirmed')
      expect(done.stderr).not.toContain('NeverDoneWhileAskingJev')
    } finally {
      output.restore()
    }
  })

  it('refuses before calling Jev: an unclaimed gated task, an email in the question, the API key in context', async () => {
    const file = board()
    const calls: unknown[] = []
    const client = {
      systemOne: async () => {
        calls.push(true)
        return { answers: noul(0.9) }
      },
    }
    const saved = process.env.TYPESAFE_API_KEY
    const output = capture()
    try {
      const email = await main(['--yes-no', 'Ask someone@example.com?'], { client })
      expect(email).toBe(1)
      expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error).toMatch(/email address/)

      process.env.TYPESAFE_API_KEY = 'sk-test-ask-key'
      const keyed = await main(['--yes-no', 'Is it fine?', '--context', 'key sk-test-ask-key'], { client })
      expect(keyed).toBe(1)
      expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error).toMatch(/API key/)

      const unclaimed = JSON.parse(readFileSync(file, 'utf8'))
      unclaimed.tasks[0] = { ...unclaimed.tasks[0], status: 'open', owner: null }
      writeFileSync(file, JSON.stringify(unclaimed))
      const open = await main(['--yes-no', 'Is it fine?', '--task', '1', '--by', 'qa-1'], { client })
      expect(open).toBe(1)
      expect(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error).toMatch(/needs a claim/)
      expect(calls).toHaveLength(0)
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = saved
      output.restore()
    }
  })

  it('never sends a credentials file, a private key, a live token, or evidence past the item cap', async () => {
    const file = board()
    const dir = dirs[0] ?? tmpdir()
    const env = join(dir, '.env')
    writeFileSync(env, 'DATABASE_HOST=envfile-marker')
    const pem = join(dir, 'notes.txt')
    writeFileSync(
      pem,
      `start\n-----BEGIN RSA PRIVATE KEY-----\n${'pemline '.repeat(800)}\n-----END RSA PRIVATE KEY-----\n`,
    )
    const token = join(dir, 'run.log')
    writeFileSync(token, `charged with sk_live_${'Z'.repeat(24)} ok`)
    const fine = Array.from({ length: 12 }, (_, index) => {
      const path = join(dir, `ok-${index}.txt`)
      writeFileSync(path, `suite ${index} passes`)
      return path
    })
    const script = join(import.meta.dirname, 'team-tasks.mjs')
    const boardEnv = { ...process.env, TEAM_TASKS_FILE: file }
    execFileSync(process.execPath, [script, 'evidence', '1', env, pem, token, ...fine], {
      env: boardEnv,
      stdio: 'pipe',
    })
    // Check privacy for the board's stored reference, whether copied or kept on this host.
    const storedEnv = JSON.parse(readFileSync(file, 'utf8')).tasks[0].evidence[0]
    if (process.platform !== 'win32') expect(storedEnv).toMatch(/tasks\.json\.artifacts\/1\/[0-9a-f]{12}\/\.env$/)
    expect(storedEnv.replaceAll('\\', '/')).toMatch(/\/\.env$/)
    expect(readFileSync(storedEnv, 'utf8')).toBe('DATABASE_HOST=envfile-marker')
    const sent: unknown[] = []
    const client = {
      systemOne: async (request: unknown) => {
        sent.push(request)
        return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
      },
    }
    const output = capture()
    try {
      const args = ['--check-evidence', '--summary', 'Suites pass', '--task', '1', '--by', 'qa-1']
      expect(await main(args, { client })).toBe(0)
    } finally {
      output.restore()
    }
    const request = JSON.stringify(sent[0])
    expect(request).not.toContain('envfile-marker')
    expect(request).not.toContain('pemline')
    expect(request).not.toContain('sk_live_')
    expect(request).toContain('looks like a credentials file')
    expect(request).toContain('a private key')
    expect(request).toContain('a Stripe-style key')
    expect(request).toContain('suite 8 passes')
    expect(request).not.toContain('suite 9 passes')
    expect(request).toContain('over the evidence item cap')
  })

  it('refuses a secret env value in context, a credentials context file, an unknown flag, and a non-owner', async () => {
    board()
    const dir = dirs[0] ?? tmpdir()
    const calls: unknown[] = []
    const client = {
      systemOne: async () => {
        calls.push(true)
        return { answers: noul(0.9) }
      },
    }
    const saved = process.env.JEV_ASK_TEST_SECRET
    process.env.JEV_ASK_TEST_SECRET = 'plainvalue-1234567'
    const npmrc = join(dir, '.npmrc')
    writeFileSync(npmrc, 'registry=https://example.invalid')
    const output = capture()
    const lastError = () => String(JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error)
    try {
      expect(await main(['--yes-no', 'Fine?', '--context', 'saw plainvalue-1234567 in the log'], { client })).toBe(1)
      expect(lastError()).toContain('JEV_ASK_TEST_SECRET')
      expect(lastError()).not.toContain('plainvalue-1234567')
      expect(await main(['--yes-no', 'Fine?', '--context-file', npmrc], { client })).toBe(1)
      expect(lastError()).toContain('credentials file')
      expect(await main(['--yes-no', 'Fine?', '--contxt', 'typo'], { client })).toBe(1)
      expect(lastError()).toContain('unexpected argument --contxt')
      expect(await main(['--yes-no', 'Fine?', '--task', '1', '--by', 'qa-2'], { client })).toBe(1)
      expect(lastError()).toContain('--by must be the owner')
      expect(calls).toHaveLength(0)
    } finally {
      if (saved === undefined) delete process.env.JEV_ASK_TEST_SECRET
      else process.env.JEV_ASK_TEST_SECRET = saved
      output.restore()
    }
  })

  it('replays a cache hit from its saved answers, not its saved outcome', async () => {
    const file = board()
    const calls: unknown[] = []
    const client = {
      systemOne: async () => {
        calls.push(true)
        return { answers: noul(0.9) }
      },
    }
    const output = capture()
    try {
      const args = ['--yes-no', 'Is the label whole?', '--task', '1', '--by', 'qa-1']
      expect(await main(args, { client })).toBe(0)
      const receipt = String(JSON.parse(String(output.log.mock.calls[0]?.[0])).receipt)
      const body = JSON.parse(readFileSync(receipt, 'utf8'))
      writeFileSync(receipt, JSON.stringify({ ...body, outcome: 'answered', answer: 'no', p: 0.01 }))
      expect(await main(args, { client })).toBe(0)
      expect(JSON.parse(String(output.log.mock.calls[1]?.[0]))).toMatchObject({ cached: true, answer: 'yes' })
      expect(judgments(file)[1]).not.toHaveProperty('answers')
      writeFileSync(receipt, JSON.stringify({ ...body, answers: undefined }))
      expect(await main(args, { client })).toBe(0)
      expect(calls).toHaveLength(2)
    } finally {
      output.restore()
    }
  })

  it('refuses a non-image and a bad pick label before calling Jev', async () => {
    board()
    const calls: unknown[] = []
    const client = {
      systemOne: async () => {
        calls.push(true)
        return { answers: noul(0.9) }
      },
    }
    const dir = dirs[0] ?? tmpdir()
    const image = join(dir, 'notes.gif')
    writeFileSync(image, 'GIF89a not a picture')
    const output = capture()
    try {
      const refused = await main(['--yes-no', 'Is it clipped?', '--image', image], { client })
      expect(refused).toBe(1)
      expect(calls).toHaveLength(0)
      expect(JSON.parse(String(output.log.mock.calls[0]?.[0])).error).toMatch(/PNG or JPEG/)
      const labels = await main(['--pick', 'Bad,ok', '--question', 'Which?'], { client })
      expect(labels).toBe(1)
      expect(calls).toHaveLength(0)
      expect(output.log).toHaveBeenCalledTimes(2)
    } finally {
      output.restore()
    }
  })

  function confirmed() {
    return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
  }

  it('omits an oversized historical screenshot and still checks the in-range image', async () => {
    const file = board()
    const historical = retain(file, 'phone.png', pngHeader(1170, 2532))
    const current = retain(file, 'fitted.png', pngHeader(390, 844))
    const overEdge = retain(file, 'over-edge.png', pngHeader(1569, 280))
    const tiny = retain(file, 'tiny.png', pngHeader(100, 100))
    const calls: unknown[] = []
    const client = {
      systemOne: async (request: unknown) => {
        calls.push(request)
        return confirmed()
      },
    }
    const output = capture()
    try {
      expect(await main(checkArgs('acceptance', [current]), { client })).toBe(0)
      const state = (
        calls[0] as {
          state: { currentEvidence: Record<string, unknown>[]; historicalEvidence: Record<string, unknown>[] }
        }
      ).state
      expect(state.currentEvidence.map((item) => item.ref)).toEqual([current])
      expect(state.currentEvidence[0]).toHaveProperty('image')
      const omitted = state.historicalEvidence
      expect(omitted.map((item) => item.ref)).toEqual([historical, overEdge, tiny])
      expect(omitted.every((item) => item.sent === false && !('image' in item))).toBe(true)
      expect(omitted[0]?.why).toContain('1170x2532')
      expect(omitted[0]?.why).toContain('sips -Z 1568')
      expect(omitted[1]?.why).toContain('1569x280')
      expect(omitted[2]?.why).toContain('100x100')
      expect(String(omitted[2]?.why)).not.toContain('sips')
    } finally {
      output.restore()
    }
  })

  it('refuses an oversized current image or --image before calling Jev', async () => {
    const file = board()
    const current = retain(file, 'phone.png', pngHeader(1170, 2532))
    const client = {
      systemOne: vi.fn(async (request: unknown) => {
        const questions = (request as { questions: Record<string, unknown> }).questions
        if ('answer' in questions) return { answers: noul(0.9) }
        return confirmed()
      }),
    }
    const output = capture()
    try {
      expect(await main(checkArgs('acceptance', [current]), { client })).toBe(1)
      const refused = JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error as string
      expect(refused).toContain('1170x2532')
      expect(refused).toContain('280 to 1568')
      expect(refused).toContain('sips -Z 1568')
      const dir = dirs[0] ?? tmpdir()
      const jpeg = join(dir, 'tall.jpg')
      writeFileSync(jpeg, jpegHeader(1170, 2532))
      expect(await main(['--yes-no', 'Is it clipped?', '--image', jpeg], { client })).toBe(1)
      const imageError = JSON.parse(String(output.log.mock.calls.at(-1)?.[0])).error as string
      expect(imageError).toContain('tall.jpg')
      expect(imageError).toContain('sips -Z 1568')
      writeFileSync(jpeg, jpegHeader(1568, 280))
      expect(await main(['--yes-no', 'Is it clipped?', '--image', jpeg], { client })).toBe(0)
      expect(client.systemOne).toHaveBeenCalledTimes(1)
      const sent = client.systemOne.mock.calls[0]?.[0] as { state: { images?: unknown[] } }
      expect(sent.state.images).toHaveLength(1)
    } finally {
      output.restore()
    }
  })
})
