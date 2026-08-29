import type { CallId, TurnId } from './ids'
import type { ToolResult } from './tool'

/** Conversation state. Deliberately serialisable: a transcript is data (R5.5). */

export interface UserMessage {
  readonly role: 'user'
  readonly content: string
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: string | null
  readonly toolCalls: ReadonlyArray<ToolCallRequest>
}

export interface ToolMessage {
  readonly role: 'tool'
  readonly toolCallId: string
  readonly name: string
  readonly content: string
}

export interface SystemMessage {
  readonly role: 'system'
  readonly content: string
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage | SystemMessage

export interface ToolCallRequest {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ToolCallRecord {
  readonly callId: CallId
  readonly requestId: string
  readonly name: string
  readonly input: unknown
  readonly result?: ToolResult
  readonly errorTag?: string
  readonly errorMessage?: string
  readonly durationMs?: number
  readonly startedAt: number
}

export type TurnState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'step_limit_exceeded'

export interface Turn {
  readonly id: TurnId
  readonly state: TurnState
  readonly userMessage: string
  readonly steps: number
  readonly messages: ReadonlyArray<ChatMessage>
  readonly toolCalls: ReadonlyArray<ToolCallRecord>
  readonly finalText: string | null
  readonly errorTag?: string
  readonly errorMessage?: string
  readonly remedy?: string
  readonly startedAt: number
  readonly endedAt?: number
}

export const isTerminal = (state: TurnState): boolean => state !== 'running'
