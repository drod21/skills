// What the task page holds about one thread: the last good read, why the latest read failed, and the live connection
// that keeps it fresh. The page keeps showing the last good thread whatever the network does.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardFailure } from '../board/board-contract'
import type { ThreadResult } from './thread-client'
import { connectThread, type ThreadConnection } from './thread-connection'
import type { Thread } from './thread-contract'

/** While a message is on its way the page asks this often, so "delivered" shows within seconds. */
const IN_FLIGHT_POLL_MS = 3_000

export type ThreadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; failure: BoardFailure }
  | { kind: 'ready'; thread: Thread; readError: BoardFailure | null }

const isInFlight = (thread: Thread) =>
  thread.deliveries.some((delivery) => delivery.state === 'pending' || delivery.state === 'sending')

const missing = (result: ThreadResult) =>
  !result.ok && result.failure.kind === 'refused' && /does not exist/.test(result.failure.message)

function apply(before: ThreadState, result: ThreadResult): ThreadState {
  if (result.ok) return { kind: 'ready', thread: result.thread, readError: null }
  if (missing(result)) return { kind: 'missing' }
  return before.kind === 'ready'
    ? { kind: 'ready', thread: before.thread, readError: result.failure }
    : { kind: 'failed', failure: result.failure }
}

export function useThread(id: number) {
  const [state, setState] = useState<ThreadState>({ kind: 'loading' })
  const [live, setLive] = useState(false)
  const connection = useRef<ThreadConnection | null>(null)
  const inFlight = state.kind === 'ready' && isInFlight(state.thread)

  useEffect(() => {
    const open = connectThread(id, (result) => setState((before) => apply(before, result)), setLive)
    connection.current = open
    return () => {
      open.close()
      connection.current = null
    }
  }, [id])

  // A message on its way changes without the board announcing every step, so read faster until it settles.
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => connection.current?.reload(), IN_FLIGHT_POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight])

  const refresh = useCallback(() => connection.current?.reload(), [])
  return { state, live, refresh }
}
