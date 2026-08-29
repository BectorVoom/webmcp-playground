import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from './config'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

describe('loadConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = run(loadConfig({}))
    expect(config.llmBaseUrl).toBe('http://localhost:11434/v1')
    expect(config.llmTimeoutMs).toBe(120_000)
    expect(config.port).toBe(8787)
    expect(config.traceDir).toBe('.traces')
  })

  it('treats an empty string as unset rather than as a value', () => {
    expect(run(loadConfig({ LLM_API_KEY: '   ' })).llmApiKey).toBeUndefined()
  })

  it('strips a trailing slash so URL joining stays predictable', () => {
    expect(run(loadConfig({ LLM_BASE_URL: 'http://localhost:1234/v1/' })).llmBaseUrl).toBe(
      'http://localhost:1234/v1',
    )
  })

  it('names the offending variable when a number is malformed', () => {
    const error = run(Effect.flip(loadConfig({ LLM_TIMEOUT_MS: 'soon' })))
    expect(error._tag).toBe('ConfigError')
    expect(error.variable).toBe('LLM_TIMEOUT_MS')
    expect(error.expected).toContain('positive integer')
  })

  it('rejects a non-positive timeout instead of quietly accepting it', () => {
    expect(run(Effect.flip(loadConfig({ LLM_TIMEOUT_MS: '0' }))).variable).toBe('LLM_TIMEOUT_MS')
  })

  it('rejects a malformed base URL', () => {
    expect(run(Effect.flip(loadConfig({ LLM_BASE_URL: 'localhost:11434' }))).variable).toBe(
      'LLM_BASE_URL',
    )
  })

  it('accepts only true or false for a boolean flag', () => {
    expect(run(loadConfig({ TRACE_WRITE_ENABLED: 'false' })).traceWriteEnabled).toBe(false)
    expect(run(Effect.flip(loadConfig({ TRACE_WRITE_ENABLED: 'yes' }))).variable).toBe(
      'TRACE_WRITE_ENABLED',
    )
  })
})
