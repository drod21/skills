import { createFileRoute } from '@tanstack/react-router'
import { appState } from '../server/app-state.server'
import { threadResponse } from '../server/thread.server'
import { methodNotAllowed } from '../server/write-guard.server'

/** One task's journal as a thread, with the delivery state of each message. Read only. */
export const Route = createFileRoute('/api/thread/$id')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed(['GET']),
      GET: ({ params }) => threadResponse(params.id, appState()),
    },
  },
})
