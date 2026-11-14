// The browser's side of the thread routes. Reads are parsed with arktype; a write carries this process's token
// (from /api/session) and says only what the owner typed: the server signs the write with the owner's name.
import { type } from 'arktype'
import { fetchSession } from '../board/board-client'
import type { BoardFailure } from '../board/board-contract'
import {
  parseThreadEnvelope,
  parseThreadList,
  parseWriteEnvelope,
  type Thread,
  type ThreadListItem,
} from './thread-contract'

const TOKEN_HEADER = 'x-board-token'

export type ThreadResult = { ok: true; thread: Thread } | { ok: false; failure: BoardFailure }
export type WriteResult = { ok: true } | { ok: false; failure: BoardFailure }
export type ListResult = { ok: true; threads: ThreadListItem[] } | { ok: false; failure: BoardFailure }

const network = (message: string): { ok: false; failure: BoardFailure } => ({
  ok: false,
  failure: { kind: 'network', message },
})

export async function fetchThread(id: number, signal: AbortSignal): Promise<ThreadResult> {
  try {
    const response = await fetch(`/api/thread/${id}`, { signal, headers: { accept: 'application/json' } })
    const parsed = parseThreadEnvelope(await response.text())
    if (parsed instanceof type.errors)
      return network(`the server answered ${response.status} with something that is not a thread`)
    return parsed.ok ? { ok: true, thread: parsed.thread } : parsed
  } catch (error) {
    if (signal.aborted) throw error
    return network('the board server cannot be reached')
  }
}

export async function fetchThreadList(signal: AbortSignal): Promise<ListResult> {
  try {
    const response = await fetch('/api/thread/threads', { signal, headers: { accept: 'application/json' } })
    const parsed = parseThreadList(await response.text())
    if (parsed instanceof type.errors)
      return network(`the server answered ${response.status} with something that is not a thread list`)
    return parsed
  } catch (error) {
    if (signal.aborted) throw error
    return network('the board server cannot be reached')
  }
}

let tokenRequest: Promise<string | null> | null = null

/** The token for this server process, read once. A server restart changes it; `forgetToken` makes the next write ask again. */
function token(): Promise<string | null> {
  tokenRequest ??= fetchSession(new AbortController().signal).then((session) => session?.token ?? null)
  return tokenRequest
}
export function forgetToken() {
  tokenRequest = null
}

async function post(path: string, body: unknown): Promise<WriteResult> {
  const key = await token()
  if (key === null) {
    forgetToken()
    return network('the board server did not hand out a session, so nothing was sent')
  }
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', [TOKEN_HEADER]: key },
      body: JSON.stringify(body),
    })
    const parsed = parseWriteEnvelope(await response.text())
    if (parsed instanceof type.errors)
      return network(`the server answered ${response.status} with something this page cannot read`)
    // 403 is a stale token (the server restarted): ask for a fresh one next time.
    if (!parsed.ok && response.status === 403) forgetToken()
    return parsed
  } catch {
    return network('the board server cannot be reached, so nothing was sent')
  }
}

export const sendMessage = (id: number, body: { kind: 'note' | 'answer'; text: string; expected?: string }) =>
  post(`/api/thread/${id}/send`, body)

export const retryDelivery = (id: number, deliveryId: string) => post(`/api/thread/${id}/retry`, { deliveryId })

export const acceptCheck = (id: number, reason: string) => post(`/api/thread/${id}/accept`, { reason })

/** Set the lead thread for the board (`tag` omitted) or for one tag; no `threadId` clears it. */
export const setLeadThread = (body: { threadId?: string; tag?: string }) => post('/api/thread/lead', body)
