import { createFileRoute } from '@tanstack/react-router'
import { retryResponse } from '../server/thread.server'
import { methodNotAllowed } from '../server/write-guard.server'

/** Send a delivery that gave up once more. */
export const Route = createFileRoute('/api/thread/$id/retry')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed(['POST']),
      POST: ({ request, params }) => retryResponse(request, params.id),
    },
  },
})
