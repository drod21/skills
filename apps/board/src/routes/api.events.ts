import { createFileRoute } from '@tanstack/react-router'
import { appState } from '../server/app-state.server'

const KEEPALIVE_MS = 25_000
const encoder = new TextEncoder()
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

/** `event: hello` once on connect with the revision now, then `event: board` after each change to the board. */
export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const { watcher } = appState()
        let end = () => {}
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (chunk: Uint8Array) => {
              try {
                controller.enqueue(chunk)
              } catch {
                end()
              }
            }
            send(encoder.encode('retry: 3000\n\n'))
            send(frame('hello', { revision: watcher.revision() ?? '' }))
            const unsubscribe = watcher.subscribe((change) => send(frame('board', change)))
            const keepalive = setInterval(() => send(encoder.encode(': keepalive\n\n')), KEEPALIVE_MS)
            end = () => {
              unsubscribe()
              clearInterval(keepalive)
              try {
                controller.close()
              } catch {
                // Already closed by the client.
              }
            }
            request.signal.addEventListener('abort', end, { once: true })
          },
          cancel: () => end(),
        })
        return new Response(body, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            'x-accel-buffering': 'no',
          },
        })
      },
    },
  },
})
