import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Effect } from 'effect'
import type { AppRuntime } from '../../app/runtime'

/**
 * The single Effect→React boundary (design §7.1). Components below this line
 * never see an Effect, a Layer or a Fiber — they see values, callbacks and
 * loading flags. That is what keeps Effect's learning cost inside app/ and
 * adapters/ rather than spreading through the UI.
 */

export interface Subscribable<T> {
  readonly subscribe: (listener: () => void) => () => void
  readonly snapshot: () => T
}

/** Reads any of our plain subscribable stores. */
export const useStore = <T>(store: Subscribable<T>): T =>
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)

export interface AsyncState<A> {
  readonly pending: boolean
  readonly value: A | undefined
  readonly error: unknown
}

/** Fire-and-observe for effects triggered by user interaction. */
export const useRunEffect = <A, E>(runtime: AppRuntime) => {
  const [state, setState] = useState<AsyncState<A>>({
    pending: false,
    value: undefined,
    error: undefined,
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(
    (effect: Effect.Effect<A, E, never>) => {
      setState((prev) => ({ ...prev, pending: true, error: undefined }))
      return runtime
        .runPromise(effect)
        .then((value) => {
          if (mounted.current) setState({ pending: false, value, error: undefined })
          return value
        })
        .catch((error: unknown) => {
          if (mounted.current) setState({ pending: false, value: undefined, error })
          return undefined
        })
    },
    [runtime],
  )

  return [state, run] as const
}
