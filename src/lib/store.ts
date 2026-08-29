/**
 * Small subscribable stores backing the stateful tool sets. Exported so the UI
 * can render what the tools actually did: a tool whose effect is invisible
 * teaches you nothing when it misbehaves.
 */

export interface Subscribable<T> {
  readonly snapshot: () => T
  readonly subscribe: (listener: () => void) => () => void
}

export const createStore = <T>(initial: T) => {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    snapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next: T) => {
      value = next
      for (const listener of listeners) listener()
    },
    update: (fn: (current: T) => T) => {
      value = fn(value)
      for (const listener of listeners) listener()
    },
  }
}

export type Store<T> = ReturnType<typeof createStore<T>>
