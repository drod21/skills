// The browser's side of the two read routes. Every response is parsed with zod before the page uses it.
import { parseBoardEnvelope, parseSession, type BoardFailure, type BoardView, type Session } from './board-contract'
import type { ServerFilters } from './columns'

/** Closed cards per page. The server accepts up to 200; the phone stays quick at 50. */
export const CLOSED_PAGE_SIZE = 50

export type ViewResult = { ok: true; view: BoardView } | { ok: false; failure: BoardFailure }

const network = (message: string): ViewResult => ({ ok: false, failure: { kind: 'network', message } })

function viewUrl(filters: ServerFilters, closedBefore: string | null): string {
  const params = new URLSearchParams({ closedLimit: String(CLOSED_PAGE_SIZE) })
  for (const key of ['role', 'tag', 'owner'] as const) if (filters[key] !== '') params.set(key, filters[key])
  if (closedBefore !== null) params.set('closedBefore', closedBefore)
  return `/api/board?${params}`
}

/** One read of the board, narrowed by the filters. `closedBefore` asks for the closed page after that cursor. */
export async function fetchBoard(
  filters: ServerFilters,
  closedBefore: string | null,
  signal: AbortSignal,
): Promise<ViewResult> {
  try {
    const response = await fetch(viewUrl(filters, closedBefore), { signal, headers: { accept: 'application/json' } })
    const parsed = parseBoardEnvelope.safeParse(await response.text())
    if (!parsed.success) {
      return network(`the server answered ${response.status} with something that is not a board`)
    }
    return parsed.data.ok ? { ok: true, view: parsed.data.view } : { ok: false, failure: parsed.data.failure }
  } catch (error) {
    if (signal.aborted) throw error
    return network('the board server cannot be reached')
  }
}

/** Who the server thinks is asking, and which build is running. Null when the server does not answer. */
export async function fetchSession(signal: AbortSignal): Promise<Session | null> {
  try {
    const response = await fetch('/api/session', { signal, headers: { accept: 'application/json' } })
    const parsed = parseSession.safeParse(await response.text())
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
}
