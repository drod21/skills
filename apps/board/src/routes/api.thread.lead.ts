import { createFileRoute } from '@tanstack/react-router'
import { leadResponse } from '../server/thread.server'
import { methodNotAllowed } from '../server/write-guard.server'

/** Set or clear the lead thread for the whole board, or for one tag. */
export const Route = createFileRoute('/api/thread/lead')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed(['POST']),
      POST: ({ request }) => leadResponse(request),
    },
  },
})
