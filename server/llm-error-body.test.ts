import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from './config'
import { createApp } from './index'
import { makeLocalClient } from '../src/adapters/llm/local'
import { describeError, remedyFor } from '../src/domain/errors'
import { asRequestId } from '../src/domain/ids'
import type { CompletionRequest } from '../src/ports/LlmClient'

/**
 * The error body is a contract with two sides, so it is tested from both at
 * once: the real Hono app answers the real browser adapter, and what the
 * adapter reconstructs has to be the error the backend actually had.
 *
 * A tag that survives the crossing without its fields is not a preserved error
 * — it is a preserved label. This is what stopped `LlmTimeout` from being able
 * to say which budget it exceeded (R6.8, R7.2).
 */

const TIMEOUT_MS = 40

const config = Effect.runSync(
  loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:59999/v1', LLM_TIMEOUT_MS: String(TIMEOUT_MS) }),
)

const request: CompletionRequest = {
  model: 'gemma4:e4b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  strategy: 'native',
  signal: new AbortController().signal,
  requestId: asRequestId('req_1'),
}

/** Answers the client through the backend, with `upstream` standing in for the model. */
const completeVia = async (upstream: typeof fetch) => {
  const app = createApp(config)
  const original = globalThis.fetch
  globalThis.fetch = upstream
  try {
    const client = makeLocalClient('gemma4:e4b', ((input, init) =>
      app.request(input as string, init)) as typeof fetch)
    return await Effect.runPromise(Effect.either(client.complete(request)))
  } finally {
    globalThis.fetch = original
  }
}

describe('the /api/llm/chat error body', () => {
  it('carries the timeout budget, so the remedy names a number the user can raise', async () => {
    const never: typeof fetch = () => new Promise(() => undefined)
    const result = await completeVia(never)

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('LlmTimeout')
    if (result.left._tag !== 'LlmTimeout') return
    expect(result.left.timeoutMs).toBe(TIMEOUT_MS)
    expect(describeError(result.left)).toContain(`${TIMEOUT_MS} ms`)
    expect(remedyFor(result.left)).toContain('LLM_TIMEOUT_MS')
  })

  it('carries the unparseable excerpt on a protocol error, not just the complaint', async () => {
    const notJson: typeof fetch = () => Promise.resolve(new Response('<html>gateway</html>'))
    const result = await completeVia(notJson)

    if (result._tag !== 'Left') throw new Error('expected a failure')
    expect(result.left._tag).toBe('LlmProtocolError')
    if (result.left._tag !== 'LlmProtocolError') return
    expect(result.left.bodyExcerpt).toContain('gateway')
  })

  it("carries the host's verbatim words when a model has no tool template", async () => {
    const refusal: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'gemma4:e4b does not support tools' }), {
          status: 400,
        }),
      )
    const result = await completeVia(refusal)

    if (result._tag !== 'Left') throw new Error('expected a failure')
    expect(result.left._tag).toBe('ModelLacksToolSupport')
    if (result.left._tag !== 'ModelLacksToolSupport') return
    // Verbatim, not our own sentence about it wrapped back around itself.
    expect(result.left.hostMessage).toContain('does not support tools')
    expect(result.left.hostMessage).not.toContain('no native tool-calling support')
  })
})
