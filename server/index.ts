import { Effect, Exit } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { describeError } from '../src/domain/errors'
import { describeMissingRoutingKey, loadConfig, type ServerConfig } from './config'
import type { AppEnv } from './env'
import { requestLogger } from './logger'
import { healthRoutes } from './routes/health'
import { llmRoutes } from './routes/llm'
import { traceRoutes } from './routes/traces'
import { geoRoutes } from './routes/geo'
import { inundationRoutes } from './routes/inundation'
import { floodModelRoutes } from './routes/flood-model'
import { cemsForecastRoutes } from './routes/cems-forecast'
import { describeCemsConfig, resolveCemsCredentials } from './cems/credentials'
import { GeoProxyService } from './geo-proxy'

/** Startup fails loudly and precisely, or not at all (R8.5). */
const configExit = Effect.runSyncExit(loadConfig())

if (Exit.isFailure(configExit)) {
  const failure = configExit.cause._tag === 'Fail' ? configExit.cause.error : undefined
  console.error(
    failure === undefined
      ? `Configuration could not be read: ${String(configExit.cause)}`
      : `Configuration error: ${describeError(failure)}`,
  )
  console.error('See .env.example for the expected values.')
  process.exit(1)
}

const config: ServerConfig = configExit.value

// Said once, at startup, where it is cheap to notice — rather than as a 401 per route request,
// several layers from the cause.
const routingKeyWarning = describeMissingRoutingKey(config)
if (routingKeyWarning !== null) console.warn(`[config] ${routingKeyWarning}`)

// Same idea for the Copernicus token: a missing one, or one pointed at the wrong store, otherwise
// surfaces as a 404 on a dataset that says nothing about which URL was wrong. Resolved once here
// and handed to the route, rather than read again per request.
const cemsCredentials = resolveCemsCredentials()
const cemsWarning = describeCemsConfig(cemsCredentials)
if (cemsWarning !== null) console.warn(`[config] ${cemsWarning}`)

/** Development CORS stays local even when production explicitly opts into a public bind (R8.6). */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const distDir = resolve(process.cwd(), 'dist')

/** Production static serving, without pulling in a runtime-specific adapter. */
const serveFromDist = async (pathname: string): Promise<Response | undefined> => {
  const candidate = resolve(distDir, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) return undefined
  try {
    const info = await stat(candidate)
    const file = info.isDirectory() ? join(candidate, 'index.html') : candidate
    const body = await readFile(file)
    return new Response(new Uint8Array(body), {
      headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
    })
  } catch {
    return undefined
  }
}

export const createApp = (config: ServerConfig) => {
  const app = new Hono<AppEnv>()
  const geoProxy = new GeoProxyService(config)

  app.use('*', requestLogger())
  app.use('*', async (c, next) => {
    await next()

    // WebMCP is gated by the `tools` permissions-policy feature. Its default is self, but spelling
    // that out prevents a hosting platform's broad default policy from silently disabling it.
    c.header('Permissions-Policy', 'tools=(self)')
    if (config.webMcpOriginTrialToken !== undefined) {
      // Origin Trial tokens are public deployment metadata. Keeping the token server-side avoids a
      // rebuild per origin and makes rotation a configuration change rather than a source edit.
      c.header('Origin-Trial', config.webMcpOriginTrialToken)
    }
  })
  app.use('/api/*', cors({ origin: DEV_ORIGINS, allowHeaders: ['content-type', 'x-request-id'] }))

  if (config.backendApiUrl !== undefined) {
    const upstreamBase = config.backendApiUrl.replace(/\/$/, '')
    app.all('/api/*', async (c) => {
      const url = new URL(c.req.url)
      const target = `${upstreamBase}${url.pathname}${url.search}`
      const headers = new Headers(c.req.raw.headers)
      headers.set('host', new URL(upstreamBase).host)
      try {
        const res = await fetch(target, {
          method: c.req.method,
          headers,
          body:
            c.req.method !== 'GET' && c.req.method !== 'HEAD'
              ? await c.req.raw.arrayBuffer()
              : undefined,
        })
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: 'UpstreamBackendUnavailable', message }, 502)
      }
    })
  } else {
    app.route('/api/health', healthRoutes(config, geoProxy))
    app.route('/api/llm', llmRoutes(config))
    app.route('/api/traces', traceRoutes(config))
    app.route('/api/geo', geoRoutes(config, geoProxy))
    app.route('/api/geo', inundationRoutes(config, geoProxy))
    app.route('/api/geo', floodModelRoutes(config, geoProxy))
    app.route('/api/geo', cemsForecastRoutes(config, geoProxy, { credentials: cemsCredentials }))
  }

  app.notFound(async (c) => {
    const pathname = new URL(c.req.url).pathname
    if (pathname.startsWith('/api/')) return c.json({ error: 'NotFound', path: pathname }, 404)

    const asset = await serveFromDist(pathname)
    if (asset !== undefined) return asset

    // SPA fallback: any unknown non-API path is a client route.
    const index = await serveFromDist('/index.html')
    return index ?? c.text('Build the SPA first: bun run build', 404)
  })

  app.onError((error, c) => {
    console.error(JSON.stringify({ level: 'error', message: error.message, stack: error.stack }))
    return c.json({ error: 'Unhandled', message: error.message }, 500)
  })

  return app
}

export const app = createApp(config)

export default { port: config.port, fetch: app.fetch, hostname: config.hostname }
