import type { FaultKind } from '../domain/trace'

/**
 * Deliberate failure on demand (R5.10). Reproducing an error path is normally
 * the expensive part of debugging an agent; arming one here turns it into a
 * single call, from the UI or from window.__WEBMCP_DEBUG__.
 */

export interface FaultSpec {
  readonly kind: FaultKind
  readonly count: number
  /** Restrict to one tool; undefined arms the next call to any tool. */
  readonly tool?: string
}

export interface FaultInjector {
  readonly arm: (spec: FaultSpec) => void
  readonly clear: () => void
  readonly snapshot: () => FaultSpec | undefined
  readonly subscribe: (listener: () => void) => () => void
  /** Returns the fault to apply to this call, decrementing the armed count. */
  readonly consume: (toolName: string) => FaultKind | undefined
}

export const createFaultInjector = (): FaultInjector => {
  let armed: FaultSpec | undefined
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }

  return {
    arm: (spec) => {
      armed = spec.count > 0 ? spec : undefined
      notify()
    },
    clear: () => {
      armed = undefined
      notify()
    },
    snapshot: () => armed,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    consume: (toolName) => {
      if (armed === undefined) return undefined
      if (armed.tool !== undefined && armed.tool !== toolName) return undefined
      const kind = armed.kind
      const remaining = armed.count - 1
      armed = remaining > 0 ? { ...armed, count: remaining } : undefined
      notify()
      return kind
    },
  }
}
