import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from './config'
import { createApp } from './index'

const configWith = (env: Record<string, string>) => Effect.runSync(loadConfig(env))

describe('production WebMCP response headers', () => {
  it('enables the tools permissions-policy feature for the same origin', async () => {
    const response = await createApp(configWith({})).request('/api/not-found')
    expect(response.headers.get('permissions-policy')).toBe('tools=(self)')
    expect(response.headers.has('origin-trial')).toBe(false)
  })

  it('delivers a configured Origin Trial token without putting it in the client bundle', async () => {
    const response = await createApp(
      configWith({ WEBMCP_ORIGIN_TRIAL_TOKEN: 'production-token==' }),
    ).request('/api/not-found')
    expect(response.headers.get('origin-trial')).toBe('production-token==')
  })
})
