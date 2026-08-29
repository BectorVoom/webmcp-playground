import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from './config'
import { chatCompletion } from './upstream'
import { createApp } from './index'
import { describeError, remedyFor } from '../src/domain/errors'
import type { ChatProxyRequest } from '../src/domain/wire'

/**
 * The most common reason a local model appears to ignore every tool is that its
 * template has no tool support at all. Ollama says so plainly; this makes sure
 * that message becomes actionable advice rather than an opaque 400 (R4.5, R4.9).
 */
const config = Effect.runSync(loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:59999/v1' }))

const request: ChatProxyRequest = {
  model: 'gemma4:e4b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
}

const ollamaRefusal: typeof fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ error: 'registry.ollama.ai/library/gemma4:e4b does not support tools' }),
      { status: 400 },
    ),
  )

describe('a model without a tool template', () => {
  it('is classified as its own error, naming the model', async () => {
    const result = await Effect.runPromise(
      Effect.either(chatCompletion(config, request, 'req_1', ollamaRefusal)),
    )

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('ModelLacksToolSupport')
    expect(describeError(result.left)).toContain('gemma4:e4b')
  })

  it('carries the one remedy that actually helps', async () => {
    const result = await Effect.runPromise(
      Effect.either(chatCompletion(config, request, 'req_2', ollamaRefusal)),
    )
    if (result._tag !== 'Left') return
    expect(remedyFor(result.left)).toContain('prompted')
  })

  it('is not retried — asking again cannot change the answer', async () => {
    let attempts = 0
    const counting: typeof fetch = (input, init) => {
      attempts++
      return ollamaRefusal(input, init)
    }
    await Effect.runPromise(Effect.either(chatCompletion(config, request, 'req_3', counting)))
    expect(attempts).toBe(1)
  })

  it('surfaces through the route as 400 with the tag and the remedy', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ollamaRefusal
    try {
      const app = createApp(config)
      const response = await app.request('/api/llm/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })

      // 400, not 502: the upstream is healthy and answered correctly. It is the
      // request that has to change.
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: string; remedy?: string }
      expect(body.error).toBe('ModelLacksToolSupport')
      expect(body.remedy).toContain('prompted')
    } finally {
      globalThis.fetch = original
    }
  })
})
