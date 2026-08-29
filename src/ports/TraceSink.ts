import { Context, Effect } from 'effect'
import type { SessionId } from '../domain/ids'
import type { TraceCorrelation, TraceEvent, TracePayload } from '../domain/trace'

/**
 * The sink every part of the system writes to. Deliberately narrow: emit, read,
 * subscribe, clear. Rendering, filtering, export and disk persistence are all
 * built on top of these four (R5.1).
 */
export interface TraceSinkService {
  readonly sessionId: SessionId
  readonly emit: (payload: TracePayload, correlation?: TraceCorrelation) => Effect.Effect<void>
  readonly snapshot: () => ReadonlyArray<TraceEvent>
  readonly subscribe: (listener: () => void) => () => void
  readonly discardedCount: () => number
  readonly clear: () => Effect.Effect<void>
}

export class TraceSink extends Context.Tag('app/TraceSink')<TraceSink, TraceSinkService>() {}

/** Convenience for the common case of emitting without extra correlation. */
export const emit = (payload: TracePayload, correlation?: TraceCorrelation) =>
  Effect.flatMap(TraceSink, (sink) => sink.emit(payload, correlation))
