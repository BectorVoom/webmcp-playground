import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { createTraceStore } from '../adapters/trace/memory-store'
import { asSessionId } from '../domain/ids'
import { createAppRuntime } from './runtime'
import { TraceSink } from '../ports/TraceSink'

describe('app runtime', () => {
  it('routes Effect logs into the trace store, so console and trace never disagree', async () => {
    const store = createTraceStore(asSessionId('sess_rt'))
    const runtime = createAppRuntime(store)

    await runtime.runPromise(
      Effect.logInfo('hello').pipe(Effect.annotateLogs({ turnId: 'turn_1' })),
    )

    const record = store.snapshot().find((e) => e.payload.kind === 'LogRecord')
    expect(record?.payload).toMatchObject({ kind: 'LogRecord', level: 'info', message: 'hello' })
    expect(record?.turnId).toBe('turn_1')
    await runtime.dispose()
  })

  it('provides the trace sink to effects that ask for it', async () => {
    const store = createTraceStore(asSessionId('sess_rt2'))
    const runtime = createAppRuntime(store)

    await runtime.runPromise(
      Effect.flatMap(TraceSink, (sink) => sink.emit({ kind: 'TurnCancelled' }, { turnId: 'turn_9' as never })),
    )

    const event = store.snapshot().find((e) => e.payload.kind === 'TurnCancelled')
    expect(event?.turnId).toBe('turn_9')
    expect(event?.seq).toBeGreaterThan(0)
    await runtime.dispose()
  })
})
