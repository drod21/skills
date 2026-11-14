import { createFileRoute } from '@tanstack/react-router'
import { decideAccess } from '../server/access.server'
import { appState } from '../server/app-state.server'
import { buildInfo } from '../server/build-info.server'
import { jsonResponse } from '../server/json-response.server'

export const Route = createFileRoute('/api/session')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { config, token } = appState()
        const access = decideAccess({ headers: request.headers, port: config.port, tailnet: config.tailnet })
        if (!access.ok) return jsonResponse({ ok: false, error: access.reason }, access.status)
        return jsonResponse({ actor: access.actor, token, build: await buildInfo(config) })
      },
    },
  },
})
