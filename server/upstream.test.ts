import { describe, expect, it } from 'vitest'
import { Effect, Fiber, TestClock, TestContext } from 'effect'
import { loadConfig } from './config'
import { chatCompletion } from './upstream'
import type { ChatProxyRequest } from '../src/domain/wire'

/**
 * R4.8 with a virtual clock, so the backoff policy is asserted rather than
 * assumed and the test costs no wall-clock time.
 *
 * The distinction being tested is the one that matters: a connection that
 * failed is worth retrying; a server that answered "no" is not, and re-asking
 * only makes the same mistake more slowly.
 */
const config = Effect.runSync(loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:59999/v1' }))

const request: ChatProxyRequest = {
  model: 'test',
  messages: [{ role: 'user', content: 'hi' }],
}

const runWithClock = <A, E>(effect: Effect.Effect<A, E>, advanceMs: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.either(effect))
      yield* TestClock.adjust(advanceMs)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext)),
  )

describe('upstream retry policy', () => {
  it('retries a transport failure twice, then gives up — three attempts in all', async () => {
    let attempts = 0
    const failingFetch: typeof fetch = () => {
      attempts++
      return Promise.reject(new Error('ECONNREFUSED'))
    }

    const result = await runWithClock(chatCompletion(config, request, 'req_1', failingFetch), 10_000)

    expect(attempts).toBe(3)
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('LlmTransportError')
  })

  it('succeeds on a retry when the endpoint comes back', async () => {
    let attempts = 0
    const flakyFetch: typeof fetch = () => {
      attempts++
      if (attempts < 3) return Promise.reject(new Error('ECONNREFUSED'))
      return Promise.resolve(
        new Response(JSON.stringify({ model: 'test', choices: [{ message: { content: 'hi' } }] }), {
          status: 200,
        }),
      )
    }

    const result = await runWithClock(chatCompletion(config, request, 'req_2', flakyFetch), 10_000)

    expect(attempts).toBe(3)
    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.right.text).toBe('hi')
  })

  it('does NOT retry a non-2xx response — that is a decision, not a flaky connection', async () => {
    let attempts = 0
    const rejectingFetch: typeof fetch = () => {
      attempts++
      return Promise.resolve(new Response('model not found', { status: 404 }))
    }

    const result = await runWithClock(chatCompletion(config, request, 'req_3', rejectingFetch), 10_000)

    expect(attempts).toBe(1)
    if (result._tag === 'Left') {
      expect(result.left._tag).toBe('LlmTransportError')
      expect(result.left).toMatchObject({ status: 404 })
    }
  })

  it('does NOT retry an unparseable body', async () => {
    let attempts = 0
    const garbageFetch: typeof fetch = () => {
      attempts++
      return Promise.resolve(new Response('<html>not json</html>', { status: 200 }))
    }

    const result = await runWithClock(chatCompletion(config, request, 'req_4', garbageFetch), 10_000)

    expect(attempts).toBe(1)
    if (result._tag === 'Left') expect(result.left._tag).toBe('LlmProtocolError')
  })

  it('fails with LlmTimeout when the endpoint never answers', async () => {
    const hangingFetch: typeof fetch = () => new Promise(() => {})

    const result = await runWithClock(
      chatCompletion(config, request, 'req_5', hangingFetch),
      config.llmTimeoutMs + 1000,
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('LlmTimeout')
  })
})
