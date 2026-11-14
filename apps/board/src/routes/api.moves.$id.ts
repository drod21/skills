import { createFileRoute } from '@tanstack/react-router'
import { appState } from '../server/app-state.server'
import { handleLookup, handleMove } from '../moves/moves.server'
import { methodNotAllowed } from '../server/write-guard.server'

// GET: what the card can do. POST: do it. Any other method is refused by the ANY handler.
export const Route = createFileRoute('/api/moves/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleLookup(request, params.id, appState()),
      POST: ({ request, params }) => handleMove(request, params.id, appState()),
      ANY: () => methodNotAllowed(['GET', 'POST']),
    },
  },
})
