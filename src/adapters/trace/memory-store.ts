import type { SessionId } from '../../domain/ids'
import type { TraceCorrelation, TraceEvent, TracePayload } from '../../domain/trace'

/**
 * A bounded, subscribable event log. Plain and synchronous on purpose: React
 * reads it through useSyncExternalStore, and the Effect-facing TraceSink is a
 * thin wrapper over it. Keeping the store itself free of Effect means the
 * inspector cannot be blocked by a fiber.
 *
 * N2: retains the most recent MAX_EVENTS and records how many were dropped, so
 * a long session degrades visibly rather than silently.
 */

export const MAX_EVENTS = 5000

export interface TraceStore {
  readonly sessionId: SessionId
  readonly append: (payload: TracePayload, correlation?: TraceCorrelation) => TraceEvent
  readonly snapshot: () => ReadonlyArray<TraceEvent>
  readonly subscribe: (listener: () => void) => () => void
  readonly discardedCount: () => number
  readonly clear: () => void
  /** Load an imported trace verbatim, preserving its original sequence numbers (R5.5). */
  readonly replace: (events: ReadonlyArray<TraceEvent>, discarded?: number) => void
}

export const createTraceStore = (
  sessionId: SessionId,
  maxEvents: number = MAX_EVENTS,
): TraceStore => {
  let events: TraceEvent[] = []
  let seq = 0
  let discarded = 0
  const listeners = new Set<() => void>()

  // Snapshot identity must be stable between mutations or useSyncExternalStore
  // will loop. We swap the array reference exactly once per append.
  let frozen: ReadonlyArray<TraceEvent> = events

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const append = (payload: TracePayload, correlation?: TraceCorrelation): TraceEvent => {
    const event: TraceEvent = {
      seq: ++seq,
      at: Date.now(),
      sessionId,
      ...correlation,
      payload,
    }
    events = [...events, event]
    if (events.length > maxEvents) {
      const overflow = events.length - maxEvents
      events = events.slice(overflow)
      discarded += overflow
    }
    frozen = events
    notify()
    return event
  }

  return {
    sessionId,
    append,
    snapshot: () => frozen,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    discardedCount: () => discarded,
    clear: () => {
      events = []
      frozen = events
      seq = 0
      discarded = 0
      notify()
    },
    replace: (next, droppedCount = 0) => {
      events = [...next]
      frozen = events
      // Continue numbering above the import so a later live event cannot collide
      // with an imported one in the inspector.
      seq = events.reduce((highest, event) => Math.max(highest, event.seq), 0)
      discarded = droppedCount
      notify()
    },
  }
}
