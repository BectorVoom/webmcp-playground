import type { Effect, Schema } from 'effect'
import type { CallId, TurnId } from './ids'
import type { ToolExecutionError } from './errors'

/**
 * The application's own vocabulary for a tool. Nothing here mentions a browser
 * global, a WebMCP draft revision, or a wire format — that is the point. These
 * types are expected to outlive several WebMCP revisions (R6.1).
 */

export interface ToolAnnotations {
  /** The tool does not mutate state. Hosts may use this to skip confirmation. */
  readonly readOnlyHint: boolean
  /** The tool's output may contain text from an untrusted source. */
  readonly untrustedContentHint: boolean
}

export interface ToolContext {
  readonly signal: AbortSignal
  readonly callId: CallId
  readonly turnId: TurnId
}

export interface ToolTextContent {
  readonly type: 'text'
  readonly text: string
}

/**
 * Content-block shaped, mirroring MCP. The April 2026 WebMCP draft is internally
 * inconsistent here — `executeTool()` is specified to resolve to a stringified
 * result, while the README's `execute` callback returns content blocks. We hold
 * the richer form and let each adapter flatten or parse as its host demands
 * (design §3.1).
 */
export interface ToolResult {
  readonly content: ReadonlyArray<ToolTextContent>
  readonly isError?: boolean
}

export const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text }],
  isError,
})

export interface ToolDefinition<A, I = A> {
  readonly name: string
  readonly title?: string
  readonly description: string
  /**
   * The single declaration of the tool's input (R3.5). Runtime validation and
   * the published JSON Schema both derive from this, so they cannot drift.
   */
  readonly inputSchema: Schema.Schema<A, I, never>
  readonly annotations: ToolAnnotations
  readonly execute: (input: A, ctx: ToolContext) => Effect.Effect<ToolResult, ToolExecutionError>
}

/**
 * Existential form, for collections that hold tools of differing input types.
 * `any` is load-bearing here: Schema is invariant in its encoded parameter, so
 * `unknown` would make every concrete schema unassignable.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyToolDefinition = ToolDefinition<any, any>

export interface ToolSet {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly tools: ReadonlyArray<AnyToolDefinition>
}

/** A tool as read back from the host, rather than as we intended it (R2.4). */
export interface HostTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: unknown
  readonly annotations?: ToolAnnotations
}

/** As published to the model. */
export interface PublishedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

/**
 * The spec constrains tool names to 1–128 ASCII alphanumerics plus `_`, `-`
 * and `.`. Enforced here rather than at the host, so a bad name is a local
 * failure with a clear message instead of an opaque host rejection.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

export const isValidToolName = (name: string): boolean => TOOL_NAME_PATTERN.test(name)
