import { Effect } from 'effect'
import { Hono } from 'hono'
import { describeError, remedyFor } from '../../src/domain/errors'
import type { HealthResponse } from '../../src/domain/wire'
import type { ServerConfig } from '../config'
import type { GeoProxyService } from '../geo-proxy'
import { listModels } from '../upstream'

/**
 * Always 200 (ADR-6, R8.2).
 *
 * A 503 when the local LLM is down is indistinguishable from a dead backend,
 * which is the opposite of diagnostic. The body carries the diagnosis instead,
 * so the UI can say "start Ollama" rather than "something failed".
 */
export const healthRoutes = (config: ServerConfig, geoProxy?: GeoProxyService) =>
  new Hono().get('/', async (c) => {
    const result = await Effect.runPromise(Effect.either(listModels(config, 2000)))

    const geoStats = geoProxy?.getStats()

    const body: HealthResponse = {
      ok: true,
      backend: 'up',
      upstream:
        result._tag === 'Right'
          ? {
              baseUrl: config.llmBaseUrl,
              reachable: true,
              modelCount: result.right.length,
            }
          : {
              baseUrl: config.llmBaseUrl,
              reachable: false,
              modelCount: 0,
              error: describeError(result.left),
              remedy: remedyFor(result.left),
            },
      traceWriteEnabled: config.traceWriteEnabled,
      defaultModel: config.llmDefaultModel ?? null,
      geo: {
        dataMode: config.geoDataMode,
        cacheEntries: geoStats?.cacheEntries ?? 0,
        circuitStates: geoStats?.circuitStates ?? {},
      },
    }

    return c.json(body)
  })
