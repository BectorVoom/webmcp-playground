import { Effect, Schema } from 'effect'
import { Hono } from 'hono'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { TraceWriteRequestSchema, type TraceWriteResponse } from '../../src/domain/wire'
import type { ServerConfig } from '../config'

/**
 * Writes a trace to disk so a coding agent can read the whole episode without a
 * browser (R5.6). This is the payoff for treating the trace as data.
 *
 * Two guards, both non-negotiable because this endpoint turns a request field
 * into a file path (R8.7): the session id must be a plain identifier, and the
 * resolved path must still be inside the trace directory afterwards.
 */
export const traceRoutes = (config: ServerConfig) =>
  new Hono().post('/', async (c) => {
    if (!config.traceWriteEnabled) {
      return c.json({ error: 'TraceWriteDisabled', remedy: 'Set TRACE_WRITE_ENABLED=true' }, 403)
    }

    const raw: unknown = await c.req.json().catch(() => undefined)
    const decoded = await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(TraceWriteRequestSchema)(raw)),
    )

    if (decoded._tag === 'Left') {
      return c.json(
        {
          error: 'InvalidRequest',
          issues: 'sessionId must match ^[A-Za-z0-9_-]{1,64}$ and trace must be present',
        },
        400,
      )
    }

    const directory = resolve(process.cwd(), config.traceDir)
    const target = resolve(directory, `${decoded.right.sessionId}.json`)

    // Belt and braces: the pattern above already forbids separators, but a path
    // check is cheap and this is the one endpoint that writes to the filesystem.
    if (!target.startsWith(directory + sep)) {
      return c.json({ error: 'PathOutsideTraceDir' }, 400)
    }

    const body = JSON.stringify(decoded.right.trace, null, 2)
    await mkdir(directory, { recursive: true })
    await writeFile(target, body, 'utf8')

    const response: TraceWriteResponse = { path: target, bytes: body.length }
    return c.json(response)
  })
