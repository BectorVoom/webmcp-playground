import { Effect, Exit } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { describeError } from '../src/domain/errors'
import { loadConfig, type ServerConfig } from './config'
import type { AppEnv } from './env'
import { requestLogger } from './logger'
import { healthRoutes } from './routes/health'
import { llmRoutes } from './routes/llm'
import { traceRoutes } from './routes/traces'

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

/**
 * Local only (R8.6). This backend holds the model credential and writes files;
 * exposing it beyond the loopback interface would be a poor trade for a
 * playground that has no reason to leave the machine.
 */
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

  app.use('*', requestLogger())
  app.use('/api/*', cors({ origin: DEV_ORIGINS, allowHeaders: ['content-type', 'x-request-id'] }))

  app.route('/api/health', healthRoutes(config))
  app.route('/api/llm', llmRoutes(config))
  app.route('/api/traces', traceRoutes(config))

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

export default { port: config.port, fetch: app.fetch, hostname: '127.0.0.1' }
