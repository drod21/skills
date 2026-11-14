// A Nitro plugin: the board listens on loopback or not at all. Bun binds every interface when HOST is unset, so a
// missing or non-loopback HOST stops the server before it serves a request. Tailnet access goes through
// `tailscale serve` to the loopback port, never through a wider bind.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export function assertLoopbackBind(host: string | undefined): void {
  if (host === undefined || !LOOPBACK.has(host)) {
    throw new Error(
      `the board listens on loopback only: set HOST=127.0.0.1 (got ${host === undefined ? 'nothing' : JSON.stringify(host)})`,
    )
  }
}

/** A Nitro plugin is its default export, run once at startup. */
export default function loopbackOnly(): void {
  assertLoopbackBind(process.env.NITRO_HOST ?? process.env.HOST)
}
