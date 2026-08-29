import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from './config'
import { createApp } from './index'
import { REQUEST_ID_HEADER } from '../src/domain/wire'
import { asRequestId } from '../src/domain/ids'
import { makeLocalClient } from '../src/adapters/llm/local'

/**
 * R5.8 / task 8.7. The browser trace and the server log are two halves of one
 * story; x-request-id is the only thing that lets anyone put them back
 * together. Verified end to end rather than assumed.
 */
describe('x-request-id propagation', () => {
  const config = Effect.runSync(loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:59999/v1' }))
  const app = createApp(config)

  it('is sent by the driver and echoed by the backend, unchanged', async () => {
    const seen: string[] = []

    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      const id = headers.get(REQUEST_ID_HEADER)
      if (id !== null) seen.push(id)
      return app.request(String(input), init)
    }

    const client = makeLocalClient('test-model', fetchImpl)
    const requestId = asRequestId('req_join_me')

    const result = await Effect.runPromise(
      Effect.either(
        client.complete({
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          strategy: 'native',
          signal: new AbortController().signal,
          requestId,
        }),
      ),
    )

    expect(seen).toEqual(['req_join_me'])
    // Upstream is deliberately unreachable: the point is the id, not the answer.
    expect(result._tag).toBe('Left')

    const echoed = await app.request('/api/health', {
      headers: { [REQUEST_ID_HEADER]: 'req_join_me' },
    })
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe('req_join_me')
  })

  it('generates a server-side id when the client sends none, so a log line is never anonymous', async () => {
    const response = await app.request('/api/health')
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^srv_/)
  })
})
