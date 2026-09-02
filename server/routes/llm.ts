import { Effect, Schema } from 'effect'
import { Hono } from 'hono'
import { describeError, remedyFor, type AppError } from '../../src/domain/errors'
import {
  ChatProxyRequestSchema,
  type ChatProxyErrorBody,
  type ModelsResponse,
} from '../../src/domain/wire'
import type { AppEnv } from '../env'
import type { ServerConfig } from '../config'
import { chatCompletion, listModels } from '../upstream'

const STATUS_FOR_TAG: Record<string, 400 | 502 | 504> = {
  LlmTransportError: 502,
  LlmProtocolError: 502,
  LlmTimeout: 504,
  // Not an upstream fault: the request asked a model to do something its
  // template cannot. 400 says "change the request", which is the right advice.
  ModelLacksToolSupport: 400,
}

/**
 * Carries the failing error's own fields across, not just its tag. The client
 * rebuilds the tagged error from this, and a field dropped here is a remedy the
 * user reads with a hole in it.
 */
const errorBody = (error: AppError, requestId: string): ChatProxyErrorBody => ({
  error: error._tag,
  message: describeError(error),
  remedy: remedyFor(error),
  requestId,
  ...(error._tag === 'LlmTimeout' ? { timeoutMs: error.timeoutMs } : {}),
  ...(error._tag === 'LlmProtocolError' ? { bodyExcerpt: error.bodyExcerpt } : {}),
  ...(error._tag === 'ModelLacksToolSupport' ? { hostMessage: error.hostMessage } : {}),
})

export const llmRoutes = (config: ServerConfig) =>
  new Hono<AppEnv>()
    /** An unreachable upstream yields an empty list, not a 500 (R5 usability). */
    .get('/models', async (c) => {
      const result = await Effect.runPromise(Effect.either(listModels(config)))
      const body: ModelsResponse =
        result._tag === 'Right'
          ? { models: result.right, upstreamReachable: true }
          : { models: [], upstreamReachable: false, error: describeError(result.left) }
      return c.json(body)
    })

    .post('/chat', async (c) => {
      const raw: unknown = await c.req.json().catch(() => undefined)

      const decoded = await Effect.runPromise(
        Effect.either(Schema.decodeUnknown(ChatProxyRequestSchema)(raw)),
      )

      if (decoded._tag === 'Left') {
        // Named fields, not a formatted tree: the client renders these as a list
        // and an agent can read them without parsing prose (R8.3).
        const issues = await Effect.runPromise(
          Effect.map(
            Effect.succeed(decoded.left),
            (error) => error.message.split('\n').slice(0, 12).join('\n'),
          ),
        )
        return c.json({ error: 'InvalidRequest', issues }, 400)
      }

      const requestId = c.get('requestId')
      const result = await Effect.runPromise(
        Effect.either(chatCompletion(config, decoded.right, requestId)),
      )

      if (result._tag === 'Left') {
        return c.json(
          errorBody(result.left, requestId),
          STATUS_FOR_TAG[result.left._tag] ?? 502,
        )
      }

      return c.json(result.right)
    })
