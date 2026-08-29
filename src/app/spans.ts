import { Duration, Effect } from 'effect'

/**
 * Timing is measured once, at the span, and carried into the trace event that
 * describes the thing that was timed (R7.4, task 2.8). No separate stopwatch
 * scattered through the call sites, and therefore no chance of the displayed
 * duration disagreeing with the span.
 */
export const timedSpan = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [number, A], E, R> =>
  Effect.timed(Effect.withSpan(name)(effect)).pipe(
    Effect.map(([duration, value]) => [Math.round(Duration.toMillis(duration)), value] as const),
  )

/** Same, but keeps the duration when the effect fails — used for failed tool calls. */
export const timedSpanEither = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [number, Effect.Effect<A, E>], never, R> =>
  Effect.gen(function* () {
    const started = yield* Effect.sync(() => performance.now())
    const exit = yield* Effect.exit(Effect.withSpan(name)(effect))
    const elapsed = yield* Effect.sync(() => Math.round(performance.now() - started))
    return [elapsed, exit] as const
  })
