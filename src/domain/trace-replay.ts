import type { ToolCallRecord, Turn } from './chat'
import { asTurnId } from './ids'
import type { TraceEvent, TraceExport } from './trace'

/**
 * Rebuilds a transcript from a trace (R5.5).
 *
 * This is only possible because the trace was designed as the primary record
 * rather than as logging: every fact the transcript needs is already an event
 * with correlation ids. It is a pure function, so importing a trace exercises
 * no session state and cannot disturb a live one.
 */
export const reconstructTurns = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<Turn> => {
  const turns = new Map<string, Turn>()
  const order: string[] = []

  const ensure = (turnId: string, at: number): Turn => {
    const existing = turns.get(turnId)
    if (existing !== undefined) return existing
    const created: Turn = {
      id: asTurnId(turnId),
      state: 'running',
      userMessage: '',
      steps: 0,
      messages: [],
      toolCalls: [],
      finalText: null,
      startedAt: at,
    }
    turns.set(turnId, created)
    order.push(turnId)
    return created
  }

  const patch = (turnId: string, at: number, changes: Partial<Turn>) => {
    turns.set(turnId, { ...ensure(turnId, at), ...changes })
  }

  for (const event of events) {
    const turnId = event.turnId
    if (turnId === undefined) continue
    const payload = event.payload

    switch (payload.kind) {
      case 'TurnStarted':
        patch(turnId, event.at, { userMessage: payload.userMessage, startedAt: event.at })
        break

      case 'ToolCallStarted': {
        const turn = ensure(turnId, event.at)
        const record: ToolCallRecord = {
          callId: event.callId ?? `call_${event.seq}`,
          requestId: event.requestId ?? '',
          name: payload.tool,
          input: payload.input,
          startedAt: event.at,
        } as ToolCallRecord
        patch(turnId, event.at, { toolCalls: [...turn.toolCalls, record] })
        break
      }

      case 'ToolCallCompleted':
      case 'ToolCallFailed': {
        const turn = ensure(turnId, event.at)
        const index = turn.toolCalls.findIndex(
          (call) => call.callId === event.callId && call.durationMs === undefined,
        )
        if (index === -1) break
        const current = turn.toolCalls[index]!
        const updated: ToolCallRecord =
          payload.kind === 'ToolCallCompleted'
            ? { ...current, result: payload.result, durationMs: event.durationMs ?? 0 }
            : {
                ...current,
                errorTag: payload.errorTag,
                errorMessage: payload.message,
                durationMs: event.durationMs ?? 0,
              }
        const toolCalls = [...turn.toolCalls]
        toolCalls[index] = updated
        patch(turnId, event.at, { toolCalls })
        break
      }

      case 'TurnCompleted':
        patch(turnId, event.at, {
          state: 'completed',
          steps: payload.steps,
          finalText: payload.finalText,
          endedAt: event.at,
        })
        break

      case 'TurnFailed':
        patch(turnId, event.at, {
          state: payload.errorTag === 'StepLimitExceeded' ? 'step_limit_exceeded' : 'failed',
          errorTag: payload.errorTag,
          errorMessage: payload.message,
          remedy: payload.remedy,
          endedAt: event.at,
        })
        break

      case 'TurnCancelled':
        patch(turnId, event.at, { state: 'cancelled', endedAt: event.at })
        break

      default:
        break
    }
  }

  return order.flatMap((id) => {
    const turn = turns.get(id)
    return turn === undefined ? [] : [turn]
  })
}

export const isTraceExport = (value: unknown): value is TraceExport =>
  typeof value === 'object' &&
  value !== null &&
  (value as TraceExport).formatVersion === 1 &&
  Array.isArray((value as TraceExport).events)
