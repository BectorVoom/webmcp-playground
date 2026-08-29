import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  DuplicateToolName,
  LlmTransportError,
  ToolInputInvalid,
  ToolRegistrationError,
  describeError,
  remedyFor,
  type AppError,
} from './errors'

/**
 * These tests exist to keep R5.13 honest: no error may render as an opaque
 * object, and every tag must be describable.
 */
const samples: ReadonlyArray<AppError> = [
  new ToolRegistrationError({
    tool: 'add-todo',
    adapter: 'draft-2026-04',
    hostMessage: 'Unknown field "annotations"',
  }),
  new DuplicateToolName({ tool: 'echo', owningSets: ['todo', 'diagnostics'] }),
  new ToolInputInvalid({ tool: 'add-todo', issues: [{ path: 'text', message: 'Expected string' }] }),
  new LlmTransportError({ url: 'http://localhost:11434/v1', message: 'fetch failed' }),
  new ConfigError({ variable: 'LLM_TIMEOUT_MS', value: 'soon', expected: 'a positive integer' }),
]

describe('describeError', () => {
  it('produces a non-empty, object-free message for every sample', () => {
    for (const error of samples) {
      const message = describeError(error)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('[object Object]')
    }
  })

  it('preserves the host message verbatim, because spec drift is diagnosed from it', () => {
    const error = samples[0] as ToolRegistrationError
    expect(describeError(error)).toContain('Unknown field "annotations"')
  })

  it('lists every offending path for a validation failure', () => {
    const error = new ToolInputInvalid({
      tool: 't',
      issues: [
        { path: 'a', message: 'Expected string' },
        { path: 'b.c', message: 'Missing' },
      ],
    })
    expect(describeError(error)).toContain('a — Expected string')
    expect(describeError(error)).toContain('b.c — Missing')
  })
})

describe('remedyFor', () => {
  it('offers the offline escape hatch when the model endpoint is unreachable', () => {
    expect(remedyFor(samples[3]!)).toContain('scripted driver')
  })

  it('names the variable to fix for a config error', () => {
    expect(describeError(samples[4]!)).toContain('LLM_TIMEOUT_MS')
  })

  it('returns undefined rather than filler when there is no useful advice', () => {
    expect(
      remedyFor({ _tag: 'ToolAborted', tool: 'x' } as unknown as AppError),
    ).toBeUndefined()
  })
})
