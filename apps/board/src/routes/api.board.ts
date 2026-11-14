import { createFileRoute } from '@tanstack/react-router'
import { appState } from '../server/app-state.server'
import { parseBoardQuery, runBoardView } from '../server/board-cli.server'
import { jsonResponse } from '../server/json-response.server'

export const Route = createFileRoute('/api/board')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = parseBoardQuery(new URL(request.url).searchParams)
        if (!query.ok) return jsonResponse({ ok: false, failure: query.failure }, 400)
        const outcome = await runBoardView(appState().config, query.value)
        return outcome.ok
          ? jsonResponse({ ok: true, view: outcome.value })
          : jsonResponse({ ok: false, failure: outcome.failure }, 502)
      },
    },
  },
})
