import { createFileRoute } from '@tanstack/react-router'
import { threadsResponse } from '../server/thread.server'
import { methodNotAllowed } from '../server/write-guard.server'

/** This project's T3 threads, for the lead thread picker. Read only. */
export const Route = createFileRoute('/api/thread/threads')({
  server: {
    handlers: {
      ANY: () => methodNotAllowed(['GET']),
      GET: () => threadsResponse(),
    },
  },
})
