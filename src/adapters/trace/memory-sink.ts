import { Effect, Layer } from 'effect'
import { TraceSink, type TraceSinkService } from '../../ports/TraceSink'
import { createTraceStore, type TraceStore } from './memory-store'
import type { SessionId } from '../../domain/ids'

export const makeMemorySink = (store: TraceStore): TraceSinkService => ({
  sessionId: store.sessionId,
  emit: (payload, correlation) => Effect.sync(() => void store.append(payload, correlation)),
  snapshot: store.snapshot,
  subscribe: store.subscribe,
  discardedCount: store.discardedCount,
  clear: () => Effect.sync(store.clear),
})

export const MemorySinkLayer = (store: TraceStore): Layer.Layer<TraceSink> =>
  Layer.succeed(TraceSink, makeMemorySink(store))

/** Standalone layer for tests that do not care about the store handle. */
export const TestSinkLayer = (sessionId: SessionId): Layer.Layer<TraceSink> =>
  MemorySinkLayer(createTraceStore(sessionId))
