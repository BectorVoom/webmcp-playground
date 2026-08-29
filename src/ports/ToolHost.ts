import { Context, Effect } from 'effect'
import type {
  AnyToolDefinition,
  HostTool,
  ToolResult,
} from '../domain/tool'
import type {
  ToolExecutionError,
  ToolHostUnavailable,
  ToolInputInvalid,
  ToolNotFound,
  ToolRegistrationError,
  ToolTimeout,
  ToolAborted,
} from '../domain/errors'

/**
 * The WebMCP surface reduced to what this application actually needs (R6.1).
 *
 * Note what is absent: no AbortSignal on registration, no `exposedTo`, no
 * Window, no permissions policy, no stringified-vs-content-block question.
 * Those are host details, and every one of them is a thing the draft may
 * rename. When it does, adapters move and this file does not.
 */

export type AdapterId = 'draft-2026-04' | 'legacy-navigator' | 'in-memory'

export interface SpecRevision {
  readonly label: string
  readonly url: string
}

export interface RegistrationHandle {
  readonly unregister: Effect.Effect<void>
}

export interface ToolHostService {
  readonly id: AdapterId
  readonly specRevision: SpecRevision

  readonly register: (
    tool: AnyToolDefinition,
  ) => Effect.Effect<RegistrationHandle, ToolRegistrationError>

  /**
   * Read back from the host, never from local state. A divergence between what
   * we asked for and what the host actually holds is exactly the bug this
   * playground exists to surface (R2.4).
   */
  readonly listTools: () => Effect.Effect<ReadonlyArray<HostTool>, ToolHostUnavailable>

  readonly execute: (
    name: string,
    input: unknown,
    options: { readonly signal: AbortSignal },
  ) => Effect.Effect<
    ToolResult,
    ToolNotFound | ToolInputInvalid | ToolExecutionError | ToolTimeout | ToolAborted
  >

  /**
   * Host-driven change notification (R2.5). A plain subscription rather than a
   * Stream: the only consumer is React's useSyncExternalStore, and a Stream
   * would mean running a fiber to feed a store for no gain.
   */
  readonly subscribeToChanges: (listener: () => void) => () => void
}

export class ToolHost extends Context.Tag('app/ToolHost')<ToolHost, ToolHostService>() {}
