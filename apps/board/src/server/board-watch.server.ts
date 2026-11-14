// Watches the board for change and tells the subscribers once per burst. The board is replaced by rename, so a
// file watch would go stale after the first write: this watches the directory and picks out the board's own files.
import { statSync, watch as fsWatch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

export const DEBOUNCE_MS = 250
/** If the directory watch ever misses a change (it has on network volumes), a stat catches it this late. */
export const SAFETY_CHECK_MS = 5_000

export type BoardChange = { revision: string }
type Listener = (change: BoardChange) => void

/** The revision the CLI reports for the board file: its mtime and size. */
export function boardRevision(file: string): string | null {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}-${stat.size}`
  } catch {
    return null
  }
}

function signatureOf(file: string, archive: string): string {
  return `${boardRevision(file)}|${boardRevision(archive)}`
}

export type BoardWatcher = {
  /** Listen for changes. The watch starts with the first listener and stops with the last. */
  subscribe(listener: Listener): () => void
  /** The board file's revision now, or null when it cannot be read. */
  revision(): string | null
  close(): void
}

export function createBoardWatcher(file: string, { debounceMs = DEBOUNCE_MS, safetyMs = SAFETY_CHECK_MS } = {}) {
  const directory = dirname(file)
  const names = new Set([basename(file), `${basename(file)}.archive.jsonl`])
  const archive = `${file}.archive.jsonl`
  const listeners = new Set<Listener>()
  let watcher: FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let safety: ReturnType<typeof setInterval> | undefined
  let seen = signatureOf(file, archive)

  const check = () => {
    debounce = undefined
    const signature = signatureOf(file, archive)
    if (signature === seen) return
    seen = signature
    const revision = boardRevision(file)
    if (revision === null) return
    for (const listener of listeners) listener({ revision })
  }

  const schedule = () => {
    clearTimeout(debounce)
    debounce = setTimeout(check, debounceMs)
  }

  const start = () => {
    seen = signatureOf(file, archive)
    try {
      watcher = fsWatch(directory, { persistent: false }, (_event, name) => {
        if (name !== null && names.has(String(name))) schedule()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = undefined
      })
    } catch {
      watcher = undefined
    }
    safety = setInterval(schedule, safetyMs)
    safety.unref()
    // A write in the moment before the watch armed raises no event: one check after it armed catches that write.
    schedule()
  }

  const stop = () => {
    watcher?.close()
    watcher = undefined
    clearTimeout(debounce)
    clearInterval(safety)
    debounce = undefined
    safety = undefined
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) start()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    revision: () => boardRevision(file),
    close() {
      listeners.clear()
      stop()
    },
  } satisfies BoardWatcher
}
