import type { Effect } from 'effect'
import type { AnyToolDefinition, ToolResult } from '../domain/tool'
import type { ToolError } from '../domain/errors'
import type { CallId, TurnId } from '../domain/ids'

/**
 * Every adapter executes tools through this one implementation. It is why an
 * adapter is ~150 lines rather than ~400, and — more importantly — why all
 * three behave identically under the conformance suite: validation, fault
 * injection, timeout, cancellation and tracing happen in exactly one place
 * (design §4.3).
 */
export interface ToolRunOptions {
  readonly signal: AbortSignal
  readonly callId?: CallId
  readonly turnId?: TurnId
}

export interface ToolRunner {
  readonly executeEffect: (
    tool: AnyToolDefinition,
    rawInput: unknown,
    options: ToolRunOptions,
  ) => Effect.Effect<ToolResult, ToolError>

  /** Promise form for host callbacks. Rejects with `ToolBoundaryError`; lossy hosts may encode it as a result. */
  readonly executeAsPromise: (
    tool: AnyToolDefinition,
    rawInput: unknown,
    options: ToolRunOptions,
  ) => Promise<ToolResult>
}
