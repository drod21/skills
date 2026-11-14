// The board's request guard, held to one case table: who a request is (decideAccess) and whether a write may
// proceed (assertWrite). A row that changes says the access rules moved.
import { describe, expect, it } from 'vitest'
import type { TailnetConfig } from './board-config.server'
import { TOKEN_HEADER, assertWrite, decideAccess } from './access.server'

const TOKEN = 't'.repeat(64)
const TAILNET: TailnetConfig = { host: 'mac.tail.ts.net', logins: ['owner@example.com'] }

type Verdict = 'allowed' | 'forbidden host' | 'tailnet user not allowed' | 'missing or invalid token' | 'bad origin'
type Case = {
  name: string
  host: (port: number) => string
  headers?: Record<string, string>
  /** Whether the tailnet is switched on for this case. */
  tailnet: boolean
  expected: Verdict
}

const local = (port: number) => `127.0.0.1:${port}`
const tailnetLogin = { 'tailscale-user-login': 'owner@example.com' }

const READS: Case[] = [
  { name: 'the owner at 127.0.0.1', host: local, tailnet: false, expected: 'allowed' },
  { name: 'the owner at localhost', host: (port) => `localhost:${port}`, tailnet: false, expected: 'allowed' },
  { name: 'the host name in any case', host: (port) => `LOCALHOST:${port}`, tailnet: false, expected: 'allowed' },
  { name: 'a wrong port', host: (port) => `127.0.0.1:${port + 1}`, tailnet: false, expected: 'forbidden host' },
  { name: 'a rebinding host name', host: (port) => `evil.example:${port}`, tailnet: false, expected: 'forbidden host' },
  {
    name: 'loopback with a forwarding header',
    host: local,
    headers: { 'x-forwarded-for': '100.64.0.9' },
    tailnet: false,
    expected: 'forbidden host',
  },
  {
    name: 'loopback with a tailscale login header',
    host: local,
    headers: tailnetLogin,
    tailnet: false,
    expected: 'forbidden host',
  },
  {
    name: 'the tailnet host while the tailnet is off',
    host: () => TAILNET.host,
    headers: tailnetLogin,
    tailnet: false,
    expected: 'forbidden host',
  },
  {
    name: 'an allowed tailnet login',
    host: () => TAILNET.host,
    headers: tailnetLogin,
    tailnet: true,
    expected: 'allowed',
  },
  {
    name: 'an allowed login on the :443 host',
    host: () => `${TAILNET.host}:443`,
    headers: tailnetLogin,
    tailnet: true,
    expected: 'allowed',
  },
  {
    name: 'a login in a different case',
    host: () => TAILNET.host,
    headers: { 'tailscale-user-login': 'Owner@Example.com' },
    tailnet: true,
    expected: 'allowed',
  },
  {
    name: 'a login that is not allowed',
    host: () => TAILNET.host,
    headers: { 'tailscale-user-login': 'someone@example.com' },
    tailnet: true,
    expected: 'tailnet user not allowed',
  },
  {
    name: 'the tailnet host with no login',
    host: () => TAILNET.host,
    tailnet: true,
    expected: 'tailnet user not allowed',
  },
  {
    name: 'a stranger host with the tailnet on',
    host: () => 'other.ts.net',
    headers: tailnetLogin,
    tailnet: true,
    expected: 'forbidden host',
  },
]

const WRITES: Case[] = [
  {
    name: 'the owner with the token',
    host: local,
    headers: { [TOKEN_HEADER]: TOKEN },
    tailnet: false,
    expected: 'allowed',
  },
  { name: 'no token', host: local, tailnet: false, expected: 'missing or invalid token' },
  {
    name: 'a wrong token',
    host: local,
    headers: { [TOKEN_HEADER]: 'x'.repeat(64) },
    tailnet: false,
    expected: 'missing or invalid token',
  },
  {
    name: 'a foreign Origin from the Mac',
    host: local,
    headers: { [TOKEN_HEADER]: TOKEN, origin: 'https://evil.example' },
    tailnet: false,
    expected: 'bad origin',
  },
  {
    name: 'the local Origin from the Mac',
    host: local,
    headers: { [TOKEN_HEADER]: TOKEN, origin: 'http://localhost:PORT' },
    tailnet: false,
    expected: 'allowed',
  },
  {
    name: 'a tailnet write with no Origin',
    host: () => TAILNET.host,
    headers: { ...tailnetLogin, [TOKEN_HEADER]: TOKEN },
    tailnet: true,
    expected: 'bad origin',
  },
  {
    name: 'a tailnet write from the tailnet Origin',
    host: () => TAILNET.host,
    headers: { ...tailnetLogin, [TOKEN_HEADER]: TOKEN, origin: `https://${TAILNET.host}` },
    tailnet: true,
    expected: 'allowed',
  },
  {
    name: 'a tailnet write from the local Origin',
    host: () => TAILNET.host,
    headers: { ...tailnetLogin, [TOKEN_HEADER]: TOKEN, origin: 'http://127.0.0.1:PORT' },
    tailnet: true,
    expected: 'bad origin',
  },
]


const PORT = 4788

const withPort = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value.replace('PORT', String(PORT))]))

function boardRead(test: Case): Verdict {
  const access = decideAccess({
    headers: new Headers({ host: test.host(PORT), ...withPort(test.headers ?? {}) }),
    port: PORT,
    tailnet: test.tailnet ? TAILNET : null,
  })
  return access.ok ? 'allowed' : (access.reason as Verdict)
}

function boardWrite(test: Case): Verdict {
  const headers = new Headers({ host: test.host(PORT), ...withPort(test.headers ?? {}) })
  const access = decideAccess({ headers, port: PORT, tailnet: test.tailnet ? TAILNET : null })
  if (!access.ok) return access.reason as Verdict
  return (assertWrite(access, headers, TOKEN) ?? 'allowed') as Verdict
}

describe('reads', () => {
  it.each(READS)('$name', (test) => {
    expect(boardRead(test)).toBe(test.expected)
  })
})

describe('writes', () => {
  it.each(WRITES)('$name', (test) => {
    expect(boardWrite(test)).toBe(test.expected)
  })
})
