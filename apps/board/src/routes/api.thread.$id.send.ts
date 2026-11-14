import { createFileRoute } from '@tanstack/react-router'
import { sendResponse } from '../server/thread.server'
import { methodNotAllowed } from '../server/write-guard.server'

/** The owner's answer to the open question, or a note to the lead. */
export const Route = createFileRoute('/api/thread/$id/send')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed(['POST']),
      POST: ({ request, params }) => sendResponse(request, params.id),
    },
  },
})
