// The live connection for one thread, as plain code the hook starts and stops (like the board's): it reads the thread,
// listens for the server's `board` events, and falls back to polling while the stream is down.
import { POLL_MS } from '../board/board-connection'
import { fetchThread, type ThreadResult } from './thread-client'

/** Even with the stream up, a read older than this is read again, in case an event was lost. */
const REFRESH_MS = 60_000

export type ThreadConnection = { reload: () => void; close: () => void }

export function connectThread(
  id: number,
  onResult: (result: ThreadResult) => void,
  onLive: (live: boolean) => void,
): ThreadConnection {
  const controller = new AbortController()
  const source = new EventSource('/api/events')
  let streamOpen = false
  let lastLoadAt = 0
  let running = false
  let again = false

  // One read at a time; a request that arrives while one runs makes the same read run once more.
  const load = async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const result = await fetchThread(id, controller.signal)
        lastLoadAt = Date.now()
        onResult(result)
      } while (again)
    } catch {
      // Aborted: the page closed or the task changed.
    } finally {
      running = false
    }
  }

  source.addEventListener('open', () => {
    streamOpen = true
    onLive(true)
  })
  source.addEventListener('error', () => {
    streamOpen = false
    onLive(false)
  })
  source.addEventListener('hello', () => void load())
  source.addEventListener('board', () => void load())
  const timer = setInterval(() => {
    if (!streamOpen || Date.now() - lastLoadAt > REFRESH_MS) void load()
  }, POLL_MS)
  const onVisible = () => {
    if (!document.hidden) void load()
  }
  document.addEventListener('visibilitychange', onVisible)
  void load()

  return {
    reload: () => void load(),
    close: () => {
      controller.abort()
      source.close()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    },
  }
}
