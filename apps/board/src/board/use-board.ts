// What the page holds about the board: the reducer state, the filters, older closed pages, and the running
// connection. The connection itself lives in board-connection.ts.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { fetchBoard, fetchSession } from './board-client'
import { connectBoard, type BoardConnection } from './board-connection'
import { boardReducer, closedCursor, initialBoardState } from './board-state'
import type { Session } from './board-contract'
import { NO_FILTERS, type Filters } from './columns'

/** How long a changed card keeps its mark. */
const SETTLE_MS = 2_000
const CLOCK_MS = 15_000

export type OlderStatus = 'idle' | 'loading' | 'failed'

/** A clock for "5m ago" labels. The first render has no data on screen, so the server and browser agree. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function useBoard() {
  const [state, dispatch] = useReducer(boardReducer, initialBoardState)
  const [filters, setFiltersState] = useState<Filters>(NO_FILTERS)
  const [olderStatus, setOlderStatus] = useState<OlderStatus>('idle')
  const olderAbort = useRef<AbortController | null>(null)
  const connection = useRef<BoardConnection | null>(null)
  const { role, tag, owner } = filters

  useEffect(() => {
    const open = connectBoard({ role, tag, owner }, dispatch)
    connection.current = open
    return () => {
      open.close()
      connection.current = null
      olderAbort.current?.abort()
    }
  }, [role, tag, owner])

  useEffect(() => {
    if (state.changed.size === 0) return
    const timer = setTimeout(() => dispatch({ type: 'settled' }), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [state.changed])

  const setFilters = useCallback(
    (next: Filters) => {
      if (next.role !== role || next.tag !== tag || next.owner !== owner) {
        dispatch({ type: 'queryChanged' })
        setOlderStatus('idle')
      }
      setFiltersState(next)
    },
    [role, tag, owner],
  )

  const loadOlder = useCallback(async () => {
    const cursor = closedCursor(state)
    if (cursor === null || olderStatus === 'loading') return
    const controller = new AbortController()
    olderAbort.current = controller
    setOlderStatus('loading')
    try {
      const result = await fetchBoard({ role, tag, owner }, cursor, controller.signal)
      if (result.ok) {
        dispatch({ type: 'olderLoaded', page: { tasks: result.view.closed.tasks, next: result.view.closed.next } })
        setOlderStatus('idle')
      } else {
        setOlderStatus('failed')
      }
    } catch {
      // Aborted by a filter change, which already reset the status.
    }
  }, [state, olderStatus, role, tag, owner])

  /** Read the board now. */
  const retry = useCallback(() => connection.current?.reload(), [])

  return { state, filters, setFilters, olderStatus, loadOlder, retry }
}

/** The running build and who the server thinks is asking. Null while unknown. */
export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetchSession(controller.signal).then(setSession, () => undefined)
    return () => controller.abort()
  }, [])
  return session
}
