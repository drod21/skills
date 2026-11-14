// Who may talk to this server: the whole request guard, in one place. access.test.ts pins it with a case table.
//
// Loopback only today. A request with no proxy header on 127.0.0.1:<port> or localhost:<port> is the owner at
// the machine. A proxied request must name the tailnet host and an allowed tailnet login. Serving the tailnet is
// a matter of setting TEAM_BOARD_TAILNET_HOST and TEAM_BOARD_TAILNET_LOGINS: no route changes.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { TOKEN_HEADER } from '../board/board-contract'
import type { TailnetConfig } from './board-config.server'

export { TOKEN_HEADER }

/** Any of these means the request came through a proxy, not straight from a local browser. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login']
const LOCAL_ACTOR = 'owner'

export type Access =
  | { ok: true; actor: string; origins: string[]; originRequired: boolean }
  | { ok: false; status: 403; reason: string }

export type AccessInput = { headers: Headers; port: number; tailnet: TailnetConfig | null }

/** Decide who this request is. Reads need only this; writes also pass assertWrite. */
export function decideAccess({ headers, port, tailnet }: AccessInput): Access {
  const host = (headers.get('host') ?? '').toLowerCase()
  const proxied = PROXY_HEADERS.some((name) => headers.has(name))
  if (!proxied && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)) {
    return {
      ok: true,
      actor: LOCAL_ACTOR,
      origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      originRequired: false,
    }
  }
  if (tailnet && (host === tailnet.host || host === `${tailnet.host}:443`)) {
    const login = (headers.get('tailscale-user-login') ?? '').toLowerCase()
    if (!tailnet.logins.includes(login)) return { ok: false, status: 403, reason: 'tailnet user not allowed' }
    return { ok: true, actor: login, origins: [`https://${tailnet.host}`], originRequired: true }
  }
  return { ok: false, status: 403, reason: 'forbidden host' }
}

const digest = (value: string) => createHash('sha256').update(value).digest()
export const tokenMatches = (given: string | null, expected: string) =>
  given !== null && timingSafeEqual(digest(given), digest(expected))

/** A random per-process token. The page carries it; a write must send it back. */
export const newToken = () => randomBytes(32).toString('hex')

/** What a write must prove on top of access: the process token, then an allowed Origin. Null means allowed. */
export function assertWrite(access: Extract<Access, { ok: true }>, headers: Headers, token: string): string | null {
  if (!tokenMatches(headers.get(TOKEN_HEADER), token)) return 'missing or invalid token'
  const origin = headers.get('origin')
  const originBad = origin === null ? access.originRequired : !access.origins.includes(origin)
  return originBad ? 'bad origin' : null
}

// Same-origin assets only, no framing: another page cannot overlay the board. Start renders its hydration data as
// inline scripts, so scripts and styles allow 'unsafe-inline'; nothing else loads from anywhere but this origin.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

/** Headers on every response. No CORS header is ever sent. */
export const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'referrer-policy': 'no-referrer',
}

/** The same response with the security headers set. The body stream is passed through, so SSE keeps streaming. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // A route may ask for a stricter cache-control of its own (the event stream adds no-transform).
    if (name !== 'cache-control' || !headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function refusal(access: Extract<Access, { ok: false }>): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify({ ok: false, error: access.reason }), {
      status: access.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  )
}
