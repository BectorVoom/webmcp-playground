import { describe, expect, it } from 'vitest'
import { isTraceExport, reconstructTurns } from './trace-replay'
import type { TraceEvent } from './trace'
import { asSessionId } from './ids'

const sessionId = asSessionId('sess_replay')
let seq = 0
const event = (
  payload: TraceEvent['payload'],
  extra: Partial<TraceEvent> = {},
): TraceEvent => ({ seq: ++seq, at: 1000 + seq, sessionId, payload, ...extra })

describe('reconstructTurns', () => {
  it('rebuilds a completed turn with its tool calls', () => {
    const turns = reconstructTurns([
      event({ kind: 'SessionStarted', userAgent: 'test' }),
      event({ kind: 'TurnStarted', userMessage: 'add milk' }, { turnId: 'turn_1' as never }),
      event(
        { kind: 'ToolCallStarted', tool: 'todo.add', input: { text: 'milk' } },
        { turnId: 'turn_1' as never, callId: 'call_1' as never },
      ),
      event(
        { kind: 'ToolCallCompleted', tool: 'todo.add', result: { content: [{ type: 'text', text: 'ok' }] } },
        { turnId: 'turn_1' as never, callId: 'call_1' as never, durationMs: 12 },
      ),
      event({ kind: 'TurnCompleted', steps: 2, finalText: 'Added.' }, { turnId: 'turn_1' as never }),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      userMessage: 'add milk',
      state: 'completed',
      finalText: 'Added.',
      steps: 2,
    })
    expect(turns[0]?.toolCalls[0]).toMatchObject({ name: 'todo.add', durationMs: 12 })
  })

  it('rebuilds a failed tool call with its tag', () => {
    const turns = reconstructTurns([
      event({ kind: 'TurnStarted', userMessage: 'fail' }, { turnId: 'turn_1' as never }),
      event(
        { kind: 'ToolCallStarted', tool: 'debug.fail', input: {} },
        { turnId: 'turn_1' as never, callId: 'call_1' as never },
      ),
      event(
        { kind: 'ToolCallFailed', tool: 'debug.fail', errorTag: 'ToolExecutionError', message: 'boom' },
        { turnId: 'turn_1' as never, callId: 'call_1' as never, durationMs: 3 },
      ),
    ])
    expect(turns[0]?.toolCalls[0]).toMatchObject({
      errorTag: 'ToolExecutionError',
      errorMessage: 'boom',
    })
  })

  it('maps a step-limit failure to its own state rather than a generic failure', () => {
    const turns = reconstructTurns([
      event({ kind: 'TurnStarted', userMessage: 'loop' }, { turnId: 'turn_1' as never }),
      event(
        { kind: 'TurnFailed', errorTag: 'StepLimitExceeded', message: 'limit' },
        { turnId: 'turn_1' as never },
      ),
    ])
    expect(turns[0]?.state).toBe('step_limit_exceeded')
  })

  it('records a cancelled turn', () => {
    const turns = reconstructTurns([
      event({ kind: 'TurnStarted', userMessage: 'hang' }, { turnId: 'turn_1' as never }),
      event({ kind: 'TurnCancelled' }, { turnId: 'turn_1' as never }),
    ])
    expect(turns[0]?.state).toBe('cancelled')
  })

  it('preserves turn order across several turns', () => {
    const turns = reconstructTurns([
      event({ kind: 'TurnStarted', userMessage: 'first' }, { turnId: 'turn_1' as never }),
      event({ kind: 'TurnCompleted', steps: 1, finalText: 'a' }, { turnId: 'turn_1' as never }),
      event({ kind: 'TurnStarted', userMessage: 'second' }, { turnId: 'turn_2' as never }),
      event({ kind: 'TurnCompleted', steps: 1, finalText: 'b' }, { turnId: 'turn_2' as never }),
    ])
    expect(turns.map((t) => t.userMessage)).toEqual(['first', 'second'])
  })

  it('ignores events with no turn, rather than inventing a turn for them', () => {
    expect(reconstructTurns([event({ kind: 'SessionStarted', userAgent: 'x' })])).toEqual([])
  })
})

describe('isTraceExport', () => {
  it('accepts a well-formed export and rejects anything else', () => {
    expect(isTraceExport({ formatVersion: 1, events: [] })).toBe(true)
    expect(isTraceExport({ formatVersion: 2, events: [] })).toBe(false)
    expect(isTraceExport({ events: [] })).toBe(false)
    expect(isTraceExport(null)).toBe(false)
    expect(isTraceExport('{}')).toBe(false)
  })
})
