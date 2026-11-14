// The one door every write to the board goes through, whatever the write is (a thread message, an Accept, a move):
// access, the per-process token, the same-origin check and a bounded JSON body. A route that writes calls
// `guardWrite` and gets the signed actor and the parsed (unchecked) body; it never reads either from the request
// itself.
import { assertWrite, decideAccess } from './access.server'
import type { Outcome } from './board-cli.server'
import type { Config } from './board-config.server'
import { jsonResponse } from './json-response.server'
import type { BoardFailure } from '../board/board-contract'

/** What the guard needs to decide: where the server listens and the write token. */
export type GuardDeps = { config: Pick<Config, 'port' | 'tailnet'>; token: string }

const JSON_LIMIT = 16 * 1024

export const failure = (kind: BoardFailure['kind'], message: string): { ok: false; failure: BoardFailure } => ({
  ok: false,
  failure: { kind, message },
})

export const STATUS: Record<BoardFailure['kind'], number> = {
  refused: 409,
  timeout: 504,
  spawn: 502,
  output: 502,
  version: 502,
  network: 502,
}

export const badRequest = (message: string) => jsonResponse(failure('refused', message), 400)

/** A route answers only the methods it handles; everything else gets this, so no method falls through to a page. */
export function methodNotAllowed(allowed: readonly string[]): Response {
  const response = jsonResponse(failure('refused', 'method not allowed'), 405)
  response.headers.set('allow', allowed.join(', '))
  return response
}

export function outcomeResponse(outcome: Outcome<unknown>): Response {
  return outcome.ok
    ? jsonResponse({ ok: true })
    : jsonResponse({ ok: false, failure: outcome.failure }, STATUS[outcome.failure.kind])
}

export type WriteContext = { actor: string; body: unknown }

/**
 * What every write passes before it touches the board: a POST from an allowed host, carrying this process's token
 * and an allowed Origin, with a small JSON body. The handler gets the signed actor and the parsed (unchecked) body.
 */
export async function guardWrite(
  request: Request,
  deps: GuardDeps,
  handle: (context: WriteContext) => Promise<Response>,
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const access = decideAccess({ headers: request.headers, port: deps.config.port, tailnet: deps.config.tailnet })
  if (!access.ok) return jsonResponse(failure('refused', access.reason), access.status)
  const refused = assertWrite(access, request.headers, deps.token)
  if (refused !== null) return jsonResponse(failure('refused', refused), 403)
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return badRequest('send JSON')
  }
  const raw = await request.text()
  if (raw.length > JSON_LIMIT) return badRequest('the request is too large')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return badRequest('the request is not JSON')
  }
  return handle({ actor: access.actor, body })
}
