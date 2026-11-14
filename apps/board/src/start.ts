import { createMiddleware, createStart } from '@tanstack/react-start'
import { appState } from './server/app-state.server'
import { decideAccess, refusal, withSecurityHeaders } from './server/access.server'

/** Every page and API request passes the guard first; every response leaves with the security headers. */
const accessGuard = createMiddleware({ type: 'request' }).server(async ({ request, next }) => {
  const { config } = appState()
  const access = decideAccess({ headers: request.headers, port: config.port, tailnet: config.tailnet })
  if (!access.ok) return refusal(access)
  const result = await next({ context: { actor: access.actor } })
  return { ...result, response: withSecurityHeaders(result.response) }
})

export const startInstance = createStart(() => ({ requestMiddleware: [accessGuard] }))
