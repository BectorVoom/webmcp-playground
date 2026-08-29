import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './env'
import { REQUEST_ID_HEADER } from '../src/domain/wire'

/**
 * One structured line per request, carrying the client's x-request-id (R8.4).
 * That id is what joins this log to the browser trace (R5.8) — without it, two
 * halves of the same failure sit in two windows with no way to line them up.
 */
export const requestLogger = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const requestId = c.req.header(REQUEST_ID_HEADER) ?? `srv_${Math.random().toString(36).slice(2, 10)}`
  c.set('requestId', requestId)
  c.header(REQUEST_ID_HEADER, requestId)

  const started = performance.now()
  await next()
  const durationMs = Math.round(performance.now() - started)

  console.info(
    JSON.stringify({
      at: new Date().toISOString(),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs,
      requestId,
    }),
  )
}
