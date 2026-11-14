import { createFileRoute } from '@tanstack/react-router'
import { acceptResponse } from '../server/thread.server'
import { methodNotAllowed } from '../server/write-guard.server'

/** Accept a held evidence check, with a reason. */
export const Route = createFileRoute('/api/thread/$id/accept')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed(['POST']),
      POST: ({ request, params }) => acceptResponse(request, params.id),
    },
  },
})
