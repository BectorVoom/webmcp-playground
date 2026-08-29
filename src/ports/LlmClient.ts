import { Context } from 'effect'
import type { Effect } from 'effect'
import type { ChatMessage, ToolCallRequest } from '../domain/chat'
import type { PublishedTool } from '../domain/tool'
import type { RequestId } from '../domain/ids'
import type {
  LlmProtocolError,
  LlmTimeout,
  LlmTransportError,
  ModelLacksToolSupport,
} from '../domain/errors'

export type DriverId = 'local' | 'scripted'

/**
 * Whether tool calls travel in the `tools` request parameter or are coaxed out
 * of the model as JSON in its reply. Runtime-selectable rather than inferred
 * from the model name, because which local models handle native tool calling is
 * precisely the question this playground exists to answer (R4.5).
 */
export type ToolCallStrategy = 'native' | 'prompted'

export interface ModelInfo {
  readonly id: string
}

export interface CompletionRequest {
  readonly model: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly tools: ReadonlyArray<PublishedTool>
  readonly strategy: ToolCallStrategy
  readonly signal: AbortSignal
  readonly requestId: RequestId
}

export interface CompletionResponse {
  readonly text: string | null
  /** A thinking model's reasoning, when it reports one separately. */
  readonly reasoning?: string | null
  readonly toolCalls: ReadonlyArray<ToolCallRequest>
  /** Verbatim upstream JSON, carried to the inspector on purpose (R5.3). */
  readonly raw: unknown
  readonly requestId: RequestId
  /** Set when the prompted strategy could not parse a tool call — a finding, not a failure (R4.6). */
  readonly parseFailure?: { readonly reason: string; readonly text: string }
}

export type CompletionError =
  | LlmTransportError
  | LlmProtocolError
  | LlmTimeout
  | ModelLacksToolSupport

export interface LlmClientService {
  readonly id: DriverId
  readonly listModels: () => Effect.Effect<ReadonlyArray<ModelInfo>, LlmTransportError>
  readonly complete: (
    request: CompletionRequest,
  ) => Effect.Effect<CompletionResponse, CompletionError>
}

export class LlmClient extends Context.Tag('app/LlmClient')<LlmClient, LlmClientService>() {}
