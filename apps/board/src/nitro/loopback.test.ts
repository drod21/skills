import { describe, expect, it } from 'vitest'
import { assertLoopbackBind } from './loopback'

describe('assertLoopbackBind', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('lets the server listen on %s', (host) => {
    expect(() => assertLoopbackBind(host)).not.toThrow()
  })

  it.each(['0.0.0.0', '::', '192.168.1.20', '100.64.0.9', 'my-host.local', ''])(
    'stops the server from listening on %j',
    (host) => {
      expect(() => assertLoopbackBind(host)).toThrow(/loopback only/)
    },
  )

  it('stops a server that was never told where to listen, because Bun would bind every interface', () => {
    expect(() => assertLoopbackBind(undefined)).toThrow(/set HOST=127\.0\.0\.1 \(got nothing\)/)
  })
})
