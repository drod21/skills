import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { main } from './jev-ask.ts'

// A fake image-reference token. The real SDK rejects any serialized request that still
// carries one of these as text, because it would point at an image that is not attached.
const TOKEN = `<image:${'a'.repeat(32)}>`
const RAW_TOKEN = /<image:[0-9a-f]{32}>/

function noul(p: number) {
  return { answer: { noul: p } }
}

function gap(choiceLabel: string, confidence: number) {
  const probabilities = { fits: 0, incomplete: 0, other_check: 0, failing: 0, [choiceLabel]: 0.7 }
  return { choice: choiceLabel, confidence, probabilities }
}

function confirmed() {
  return { answers: { fits: { noul: 0.9 }, gap: gap('fits', 0.8) } }
}

function pngHeader(width: number, height: number) {
  const bytes = Buffer.alloc(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

// Each case spawns team-tasks.mjs processes; a loaded CI runner takes over the 5s default.
describe('jev-ask image-token neutralisation', { timeout: 60_000 }, () => {
  const dirs: string[] = []
  const previous = process.env.TEAM_TASKS_FILE

  afterEach(() => {
    if (previous === undefined) delete process.env.TEAM_TASKS_FILE
    else process.env.TEAM_TASKS_FILE = previous
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function board() {
    const dir = mkdtempSync(join(tmpdir(), 'jev-ask-image-token-'))
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

  function judgments(file: string) {
    const [task] = JSON.parse(readFileSync(file, 'utf8')).tasks
    return (task.decisions ?? []).filter((entry: { kind: string }) => entry.kind === 'judgment')
  }

  it('sends a text-only check receipt holding an image token: client called once, judgment from its answer, no raw token', async () => {
    const file = board()
    const receipt = retain(file, 'ask-receipt.txt', `Earlier Jev receipt attached ${TOKEN} as text.`)
    const client = { systemOne: vi.fn(async (_request: unknown) => confirmed()) }
    const output = capture()
    try {
      expect(await main(checkArgs('acceptance', [receipt]), { client })).toBe(0)
      expect(client.systemOne).toHaveBeenCalledTimes(1)

      const judgment = judgments(file).at(-1)
      expect(judgment).toMatchObject({ outcome: 'confirmed' })
      expect(String(judgment?.reasons?.[0] ?? '')).not.toMatch(/^unavailable:/)

      expect(RAW_TOKEN.test(JSON.stringify(client.systemOne.mock.calls[0]?.[0]))).toBe(false)
    } finally {
      output.restore()
    }
  })

  it('--yes-no with a token in --context: client called, request holds no raw token', async () => {
    board()
    const client = { systemOne: vi.fn(async (_request: unknown) => ({ answers: noul(0.9) })) }
    const output = capture()
    try {
      const args = [
        '--yes-no',
        'Is the label whole?',
        '--context',
        `Reviewer note quoting ${TOKEN}.`,
        '--task',
        '1',
        '--by',
        'qa-1',
      ]
      expect(await main(args, { client })).toBe(0)
      expect(client.systemOne).toHaveBeenCalledTimes(1)
      expect(RAW_TOKEN.test(JSON.stringify(client.systemOne.mock.calls[0]?.[0]))).toBe(false)
    } finally {
      output.restore()
    }
  })

  it('--yes-no with a token in --context-file: client called, request holds no raw token', async () => {
    const file = board()
    const contextFile = join(file, '..', 'context-note.txt')
    writeFileSync(contextFile, `Context file quoting ${TOKEN}.`)
    const client = { systemOne: vi.fn(async (_request: unknown) => ({ answers: noul(0.9) })) }
    const output = capture()
    try {
      const args = ['--yes-no', 'Is the label whole?', '--context-file', contextFile, '--task', '1', '--by', 'qa-1']
      expect(await main(args, { client })).toBe(0)
      expect(client.systemOne).toHaveBeenCalledTimes(1)
      expect(RAW_TOKEN.test(JSON.stringify(client.systemOne.mock.calls[0]?.[0]))).toBe(false)
    } finally {
      output.restore()
    }
  })

  it('an in-range PNG plus a token receipt: the PNG still goes as an image, no raw token in any text field', async () => {
    const file = board()
    const png = retain(file, 'fitted.png', pngHeader(390, 844))
    const receipt = retain(file, 'ask-receipt.txt', `Receipt attached with ${TOKEN} in its text.`)
    const client = { systemOne: vi.fn(async (_request: unknown) => confirmed()) }
    const output = capture()
    try {
      expect(await main(checkArgs('acceptance', [png, receipt]), { client })).toBe(0)
      expect(client.systemOne).toHaveBeenCalledTimes(1)

      const request = client.systemOne.mock.calls[0]?.[0] as {
        state: { currentEvidence: Record<string, unknown>[] }
      }
      const pngItem = request.state.currentEvidence.find((item) => item.ref === png)
      expect(pngItem).toBeDefined()
      expect(pngItem).toHaveProperty('image')

      // The SDK writes each attached image as its own reference, so the only one allowed is the PNG's.
      const serialized = JSON.stringify(request)
      expect(serialized.match(/<image:[0-9a-f]{32}>/g)).toEqual([String(pngItem?.image)])
      expect(serialized).not.toContain(TOKEN)
    } finally {
      output.restore()
    }
  })
})
