import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from '../config'
import { createApp } from '../index'
import type { HealthResponse, ModelsResponse, TraceWriteResponse } from '../../src/domain/wire'

/** Asserting against the declared wire types keeps these tests honest about the contract. */
const readJson = <T>(response: Response): Promise<T> => response.json() as Promise<T>

interface ErrorBody {
  readonly error: string
  readonly message?: string
  readonly remedy?: string
  readonly issues?: string
}

const config = Effect.runSync(loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:59999/v1' }))
const app = createApp(config)

describe('GET /api/health', () => {
  it('returns 200 even when the local LLM is unreachable, and says so', async () => {
    const response = await app.request('/api/health')
    expect(response.status).toBe(200)

    const body = await readJson<HealthResponse>(response)
    expect(body.ok).toBe(true)
    expect(body.backend).toBe('up')
    expect(body.upstream.reachable).toBe(false)
    expect(body.upstream.baseUrl).toBe('http://127.0.0.1:59999/v1')
    // The whole point of ADR-6: the response tells you what to do next.
    expect(body.upstream.remedy).toContain('scripted driver')
  })

  it('echoes the caller x-request-id so client and server logs join', async () => {
    const response = await app.request('/api/health', {
      headers: { 'x-request-id': 'req_abc' },
    })
    expect(response.headers.get('x-request-id')).toBe('req_abc')
  })
})

describe('GET /api/llm/models', () => {
  it('returns an empty list rather than a 500 when upstream is down', async () => {
    const response = await app.request('/api/llm/models')
    expect(response.status).toBe(200)
    const body = await readJson<ModelsResponse>(response)
    expect(body.models).toEqual([])
    expect(body.upstreamReachable).toBe(false)
  })
})

describe('POST /api/llm/chat', () => {
  it('rejects a malformed body with 400 and an explanation', async () => {
    const response = await app.request('/api/llm/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '', messages: [] }),
    })
    expect(response.status).toBe(400)
    expect((await readJson<ErrorBody>(response)).error).toBe('InvalidRequest')
  })

  it('rejects a missing body rather than forwarding it upstream', async () => {
    const response = await app.request('/api/llm/chat', { method: 'POST' })
    expect(response.status).toBe(400)
  })

  it('maps an unreachable upstream to 502 with a remedy', async () => {
    const response = await app.request('/api/llm/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(response.status).toBe(502)
    const body = await readJson<ErrorBody>(response)
    expect(body.error).toBe('LlmTransportError')
    expect(body.remedy).toBeTruthy()
  })
})

describe('POST /api/traces', () => {
  it('refuses a session id that could escape the trace directory', async () => {
    const response = await app.request('/api/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '../../etc/passwd', trace: {} }),
    })
    expect(response.status).toBe(400)
    expect((await readJson<ErrorBody>(response)).error).toBe('InvalidRequest')
  })

  it('refuses an over-long session id', async () => {
    const response = await app.request('/api/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'a'.repeat(65), trace: {} }),
    })
    expect(response.status).toBe(400)
  })

  it('writes a well-formed trace and reports where it went', async () => {
    const response = await app.request('/api/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess_routetest', trace: { events: [] } }),
    })
    expect(response.status).toBe(200)
    const body = await readJson<TraceWriteResponse>(response)
    expect(body.path).toMatch(/\.traces\/sess_routetest\.json$/)
    expect(body.bytes).toBeGreaterThan(0)
  })

  it('404s an unknown API path instead of falling through to the SPA', async () => {
    const response = await app.request('/api/nope')
    expect(response.status).toBe(404)
    expect((await readJson<ErrorBody>(response)).error).toBe('NotFound')
  })
})
