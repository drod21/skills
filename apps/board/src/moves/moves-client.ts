// The browser's side of the two move routes. Every answer is parsed with zod before the page uses it.
import { TOKEN_HEADER, type BoardFailure } from '../board/board-contract'
import {
  parseGuardRefusal,
  parseLookupEnvelope,
  parseMoveOutcome,
  type MoveOutcome,
  type MoveRequest,
  type MovesLookup,
} from './moves-contract'

export type LookupResult = { ok: true; moves: MovesLookup } | { ok: false; failure: BoardFailure }

const unreachable = 'the board server cannot be reached'

/** What the board says the card can do now. */
export async function fetchLookup(id: number, signal: AbortSignal): Promise<LookupResult> {
  try {
    const response = await fetch(`/api/moves/${id}`, { signal, headers: { accept: 'application/json' } })
    const parsed = parseLookupEnvelope.safeParse(await response.text())
    if (!parsed.success) {
      return { ok: false, failure: { kind: 'output', message: `the server answered ${response.status} with no moves` } }
    }
    return parsed.data.ok ? { ok: true, moves: parsed.data.moves } : { ok: false, failure: parsed.data.failure }
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, failure: { kind: 'network', message: unreachable } }
  }
}

/** A request the write guard stopped before any move ran: 403 is a refused token or origin, 400 is a bad request. */
function turnedAway(status: number, text: string): MoveOutcome {
  const parsed = parseGuardRefusal.safeParse(text)
  if (!parsed.success) {
    return { ok: false, kind: 'unavailable', message: `the server answered ${status} with no result` }
  }
  const kind = status === 403 ? 'forbidden' : status < 500 ? 'invalid' : 'unavailable'
  return { ok: false, kind, message: parsed.data.failure.message }
}

/** Do a move. A refusal, a stale card and an unreachable server all come back as an outcome to show. */
export async function postMove(token: string, id: number, request: MoveRequest): Promise<MoveOutcome> {
  try {
    const response = await fetch(`/api/moves/${id}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(request),
    })
    const text = await response.text()
    const parsed = parseMoveOutcome.safeParse(text)
    if (parsed.success) return parsed.data
    return turnedAway(response.status, text)
  } catch {
    return { ok: false, kind: 'unavailable', message: unreachable }
  }
}
