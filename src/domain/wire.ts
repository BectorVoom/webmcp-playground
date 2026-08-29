import { Schema } from 'effect'

/**
 * The contract between the SPA and the Hono backend. Shared by both sides so a
 * change cannot be applied to one and forgotten in the other, and expressed as
 * Effect Schema so the backend can validate the boundary rather than trust it
 * (R8.3).
 */

export const WireToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Unknown,
})

export const WireMessageSchema = Schema.Union(
  Schema.Struct({ role: Schema.Literal('system'), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal('user'), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal('assistant'),
    content: Schema.NullOr(Schema.String),
    toolCalls: Schema.optional(
      Schema.Array(
        Schema.Struct({ id: Schema.String, name: Schema.String, input: Schema.Unknown }),
      ),
    ),
  }),
  Schema.Struct({
    role: Schema.Literal('tool'),
    toolCallId: Schema.String,
    name: Schema.String,
    content: Schema.String,
  }),
)

export const ChatProxyRequestSchema = Schema.Struct({
  model: Schema.String.pipe(Schema.minLength(1)),
  messages: Schema.Array(WireMessageSchema).pipe(Schema.minItems(1)),
  /** Sent only for the native strategy; the prompted strategy carries tools in the prompt. */
  tools: Schema.optional(Schema.Array(WireToolSchema)),
  temperature: Schema.optional(Schema.Number),
})

export type ChatProxyRequest = Schema.Schema.Type<typeof ChatProxyRequestSchema>

export interface ChatProxyResponse {
  readonly text: string | null
  /**
   * Thinking-capable models (gemma4, qwen3, deepseek-r1) return their reasoning
   * in a separate field. It explains WHY a tool was chosen, which is the most
   * direct evidence available for whether a tool description is doing its job —
   * so it is surfaced rather than discarded.
   */
  readonly reasoning: string | null
  readonly toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>
  /** Verbatim upstream JSON (R5.3). */
  readonly raw: unknown
  readonly requestId: string
  readonly model: string
}

export interface UpstreamHealth {
  readonly baseUrl: string
  readonly reachable: boolean
  readonly modelCount: number
  readonly error?: string
  readonly remedy?: string
}

export interface HealthResponse {
  readonly ok: true
  readonly backend: 'up'
  readonly upstream: UpstreamHealth
  readonly traceWriteEnabled: boolean
  readonly defaultModel: string | null
}

export interface ModelsResponse {
  readonly models: ReadonlyArray<{ readonly id: string }>
  readonly upstreamReachable: boolean
  readonly error?: string
}

export const TraceWriteRequestSchema = Schema.Struct({
  /**
   * Constrained to a plain identifier. This value becomes part of a file path,
   * so anything else is a traversal waiting to happen (R8.7).
   */
  sessionId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,64}$/)),
  trace: Schema.Unknown,
})

export type TraceWriteRequest = Schema.Schema.Type<typeof TraceWriteRequestSchema>

export interface TraceWriteResponse {
  readonly path: string
  readonly bytes: number
}

export const REQUEST_ID_HEADER = 'x-request-id'
