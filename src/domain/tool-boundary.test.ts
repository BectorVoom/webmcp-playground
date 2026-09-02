import { describe, expect, it } from 'vitest'
import {
  ToolAborted,
  ToolExecutionError,
  ToolInputInvalid,
  ToolNotFound,
  ToolTimeout,
  type ToolError,
} from './errors'
import {
  ToolBoundaryError,
  errorFromToolBoundaryResult,
  resultForToolBoundaryError,
} from './tool-boundary'
import { textResult } from './tool'

describe('tool boundary error transport', () => {
  const errors: ReadonlyArray<ToolError> = [
    new ToolNotFound({ tool: 'demo', known: ['other'] }),
    new ToolInputInvalid({ tool: 'demo', issues: [{ path: 'text', message: 'expected string' }] }),
    new ToolExecutionError({ tool: 'demo', message: 'body failed' }),
    new ToolTimeout({ tool: 'demo', timeoutMs: 1_000 }),
    new ToolAborted({ tool: 'demo' }),
  ]

  it.each(errors)('round-trips $_tag through a JSON-safe result', (error) => {
    const result = resultForToolBoundaryError(new ToolBoundaryError(error, 'tool failed'))
    expect(result).toMatchObject({ isError: true })
    expect(result?.content[0]?.text).not.toContain('ToolBoundaryError')

    const restored = result === undefined ? undefined : errorFromToolBoundaryResult('demo', result)
    expect(restored).toMatchObject(error)
  })

  it('does not turn normal error output or a mismatched tool envelope into a boundary failure', () => {
    expect(errorFromToolBoundaryResult('demo', textResult('the upstream said no', true))).toBeUndefined()

    const result = resultForToolBoundaryError(
      new ToolBoundaryError(new ToolAborted({ tool: 'another-tool' }), 'tool cancelled'),
    )
    expect(result === undefined ? undefined : errorFromToolBoundaryResult('demo', result)).toBeUndefined()
  })
})
