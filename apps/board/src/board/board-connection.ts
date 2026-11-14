// The live connection, as plain code the hook starts and stops: it reads the board, listens for the server's `board`
// events, and falls back to polling while the stream is down. It reports through `dispatch` only, so the page always
// has a last good view to show whatever the network does.
import { type } from 'arktype'
import type { Dispatch } from 'react'
import { fetchBoard } from './board-client'
import { BoardEvent } from './board-contract'
import type { BoardAction } from './board-state'
import type { ServerFilters } from './columns'

/** While the stream is down the page asks for the board this often. */
export const POLL_MS = 10_000
/** Even with the stream up, a view older than this is read again, in case an event was lost. */
const REFRESH_MS = 60_000

export type BoardConnection = {
  /** Read the board now, whatever the stream is doing. */
  reload: () => void
  close: () => void
}

/** Open the stream and start reading. */
export function connectBoard(filters: ServerFilters, dispatch: Dispatch<BoardAction>): BoardConnection {
  const controller = new AbortController()
  const source = new EventSource('/api/events')
  let streamOpen = false
  let lastRevision: string | null = null
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
        const result = await fetchBoard(filters, null, controller.signal)
        lastLoadAt = Date.now()
        if (result.ok) {
          lastRevision = result.view.revision
          dispatch({ type: 'viewLoaded', view: result.view, at: lastLoadAt })
        } else {
          // Forget the revision, so the `hello` after a reconnect reads again even when the board did not change.
          lastRevision = null
          dispatch({ type: 'viewFailed', failure: result.failure })
        }
      } while (again)
    } catch {
      // Aborted: the filters changed or the page closed. The next connection owns the next read.
    } finally {
      running = false
    }
  }

  source.addEventListener('open', () => {
    streamOpen = true
    dispatch({ type: 'stream', status: 'open' })
  })
  source.addEventListener('error', () => {
    streamOpen = false
    dispatch({ type: 'stream', status: 'down' })
  })
  // After a reconnect the server says where the board is now; read again only if the page is behind.
  source.addEventListener('hello', (event) => {
    const hello = BoardEvent(event.data)
    if (hello instanceof type.errors || hello.revision !== lastRevision) void load()
  })
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
