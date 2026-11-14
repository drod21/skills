import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardRevision, createBoardWatcher } from './board-watch.server'
import type { BoardChange } from './board-watch.server'

const open: { close(): void }[] = []
afterEach(() => {
  for (const watcher of open.splice(0)) watcher.close()
})

function scratchBoard() {
  const directory = mkdtempSync(join(tmpdir(), 'board-watch-'))
  const file = join(directory, 'tasks.json')
  writeFileSync(file, '{"tasks":[]}')
  // The CLI replaces the board by rename, so the tests write the same way.
  const replace = (text: string) => {
    const next = join(directory, `.tasks.${Math.random().toString(36).slice(2)}.tmp`)
    writeFileSync(next, text)
    renameSync(next, file)
  }
  return { directory, file, replace }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createBoardWatcher', () => {
  it('tells the listener once for a burst of renames, with the new revision', async () => {
    const { file, replace } = scratchBoard()
    const watcher = createBoardWatcher(file, { debounceMs: 60, safetyMs: 60_000 })
    open.push(watcher)
    const changes: BoardChange[] = []
    watcher.subscribe((change) => changes.push(change))

    replace('{"tasks":[1]}')
    replace('{"tasks":[1,2]}')
    replace('{"tasks":[1,2,3]}')

    await vi.waitFor(() => expect(changes).toHaveLength(1))
    await settle(200)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.revision).toBe(boardRevision(file))
  })

  it('keeps watching after the first rename', async () => {
    const { file, replace } = scratchBoard()
    const watcher = createBoardWatcher(file, { debounceMs: 40, safetyMs: 60_000 })
    open.push(watcher)
    const changes: BoardChange[] = []
    watcher.subscribe((change) => changes.push(change))

    replace('{"tasks":[1]}')
    await vi.waitFor(() => expect(changes).toHaveLength(1))
    replace('{"tasks":[1,2]}')
    await vi.waitFor(() => expect(changes).toHaveLength(2))
  })

  it('ignores other files in the directory', async () => {
    const { directory, file } = scratchBoard()
    const watcher = createBoardWatcher(file, { debounceMs: 40, safetyMs: 60_000 })
    open.push(watcher)
    const changes: BoardChange[] = []
    watcher.subscribe((change) => changes.push(change))

    writeFileSync(join(directory, 'notes.txt'), 'unrelated')
    await settle(200)
    expect(changes).toEqual([])
  })

  it('reports a change to the archive next to the board', async () => {
    const { file, directory } = scratchBoard()
    const watcher = createBoardWatcher(file, { debounceMs: 40, safetyMs: 60_000 })
    open.push(watcher)
    const changes: BoardChange[] = []
    watcher.subscribe((change) => changes.push(change))

    writeFileSync(join(directory, 'tasks.json.archive.jsonl'), '{"id":1}\n')
    await vi.waitFor(() => expect(changes).toHaveLength(1))
  })

  it('stops telling a listener that unsubscribed, and tells every other one', async () => {
    const { file, replace } = scratchBoard()
    const watcher = createBoardWatcher(file, { debounceMs: 40, safetyMs: 60_000 })
    open.push(watcher)
    const kept: BoardChange[] = []
    const dropped: BoardChange[] = []
    watcher.subscribe((change) => kept.push(change))
    const unsubscribe = watcher.subscribe((change) => dropped.push(change))
    unsubscribe()

    replace('{"tasks":[1]}')
    await vi.waitFor(() => expect(kept).toHaveLength(1))
    expect(dropped).toEqual([])
  })

  it('catches a change the directory watch missed with its periodic check', async () => {
    const { file } = scratchBoard()
    const watcher = createBoardWatcher(file, { debounceMs: 20, safetyMs: 80 })
    open.push(watcher)
    const changes: BoardChange[] = []
    watcher.subscribe((change) => changes.push(change))

    // An in-place write of a different size: the safety check's stat sees it whether or not an event came.
    writeFileSync(file, '{"tasks":[1,2,3,4,5]}')
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1))
  })
})

describe('boardRevision', () => {
  it('is null for a board that cannot be read', () => {
    expect(boardRevision(join(tmpdir(), 'board-watch-missing', 'tasks.json'))).toBeNull()
  })
})
