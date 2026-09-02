import { Data } from 'effect'
import type { CallId, RequestId, TurnId } from './ids'

/**
 * The complete error taxonomy (design §5). Every fallible operation in the app
 * fails with one of these tags — never a bare Error, never a string, never a
 * thrown value (R7.1, R7.2).
 *
 * Each error carries enough structure that the UI can render a useful message
 * without string-parsing, and enough correlation to find the matching trace
 * events (R5.13).
 */

export class AdapterUnsupported extends Data.TaggedError('AdapterUnsupported')<{
  readonly candidate: string
  readonly reason: string
}> {}

export class ToolRegistrationError extends Data.TaggedError('ToolRegistrationError')<{
  readonly tool: string
  readonly adapter: string
  /** The host's own error, preserved verbatim so spec drift stays diagnosable (R6.8). */
  readonly hostMessage: string
  readonly cause?: unknown
}> {}

export class DuplicateToolName extends Data.TaggedError('DuplicateToolName')<{
  readonly tool: string
  readonly owningSets: ReadonlyArray<string>
}> {}

export class ToolNotFound extends Data.TaggedError('ToolNotFound')<{
  readonly tool: string
  readonly known: ReadonlyArray<string>
}> {}

export class ToolInputInvalid extends Data.TaggedError('ToolInputInvalid')<{
  readonly tool: string
  /** Dot-paths of the offending fields, e.g. ["priority", "assignee.email"]. */
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>
}> {}

export class ToolExecutionError extends Data.TaggedError('ToolExecutionError')<{
  readonly tool: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ToolTimeout extends Data.TaggedError('ToolTimeout')<{
  readonly tool: string
  readonly timeoutMs: number
}> {}

export class ToolAborted extends Data.TaggedError('ToolAborted')<{
  readonly tool: string
}> {}

export class ToolHostUnavailable extends Data.TaggedError('ToolHostUnavailable')<{
  readonly adapter: string
  readonly detail: string
}> {}

export class LlmTransportError extends Data.TaggedError('LlmTransportError')<{
  readonly url: string
  readonly status?: number
  readonly message: string
}> {}

/**
 * The endpoint accepted the request but the model has no tool-calling template.
 * Ollama says so explicitly ("<model> does not support tools"); this is the
 * single most common reason a local model appears to ignore every tool, and it
 * is a configuration answer rather than a failure — hence its own tag (R4.5).
 */
export class ModelLacksToolSupport extends Data.TaggedError('ModelLacksToolSupport')<{
  readonly model: string
  readonly hostMessage: string
}> {}

/**
 * The model returned neither text nor a tool call, twice running.
 *
 * Found against gemma4:e4b in prompted mode: a thinking model can reason its
 * way to a decision and then end the turn without stating it. Treating that as
 * a final answer completes the turn with nothing to show, which looks to the
 * user like the app broke silently — so it is an explicit failure instead.
 *
 * The loop asks once more before raising this (see `emptyResponseNudge`), so
 * reaching it means the model was silent on both asks.
 */
export class EmptyModelResponse extends Data.TaggedError('EmptyModelResponse')<{
  readonly model: string
  readonly step: number
  /** True when the model produced reasoning but no answer — the usual cause. */
  readonly hadReasoning: boolean
}> {}

export class LlmProtocolError extends Data.TaggedError('LlmProtocolError')<{
  readonly message: string
  /** A short excerpt of the offending body — enough to diagnose, not enough to flood. */
  readonly bodyExcerpt: string
}> {}

export class LlmTimeout extends Data.TaggedError('LlmTimeout')<{
  readonly timeoutMs: number
}> {}

export class StepLimitExceeded extends Data.TaggedError('StepLimitExceeded')<{
  readonly turnId: TurnId
  readonly limit: number
}> {}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly variable: string
  readonly value: string
  readonly expected: string
}> {}

export type ToolError =
  | ToolNotFound
  | ToolInputInvalid
  | ToolExecutionError
  | ToolTimeout
  | ToolAborted

export type AppError =
  | AdapterUnsupported
  | ToolRegistrationError
  | DuplicateToolName
  | ToolNotFound
  | ToolInputInvalid
  | ToolExecutionError
  | ToolTimeout
  | ToolAborted
  | ToolHostUnavailable
  | LlmTransportError
  | ModelLacksToolSupport
  | EmptyModelResponse
  | LlmProtocolError
  | LlmTimeout
  | StepLimitExceeded
  | ConfigError

export interface ErrorCorrelation {
  readonly turnId?: TurnId
  readonly callId?: CallId
  readonly requestId?: RequestId
}

/**
 * The one-line human summary. Exhaustive by construction: adding a tag to
 * AppError without extending this switch is a compile error (R7.2).
 */
export const describeError = (error: AppError): string => {
  switch (error._tag) {
    case 'AdapterUnsupported':
      return `Adapter "${error.candidate}" is unavailable: ${error.reason}`
    case 'ToolRegistrationError':
      return `Could not register "${error.tool}" with the ${error.adapter} host: ${error.hostMessage}`
    case 'DuplicateToolName':
      return `Tool name "${error.tool}" is declared by more than one enabled set: ${error.owningSets.join(', ')}`
    case 'ToolNotFound':
      return `No tool named "${error.tool}". Registered: ${error.known.join(', ') || '(none)'}`
    case 'ToolInputInvalid':
      return `Input to "${error.tool}" failed validation: ${error.issues
        .map((i) => `${i.path || '(root)'} — ${i.message}`)
        .join('; ')}`
    case 'ToolExecutionError':
      return `Tool "${error.tool}" failed: ${error.message}`
    case 'ToolTimeout':
      return `Tool "${error.tool}" exceeded its ${error.timeoutMs} ms budget`
    case 'ToolAborted':
      return `Tool "${error.tool}" was cancelled`
    case 'ToolHostUnavailable':
      return `The ${error.adapter} tool host is unavailable: ${error.detail}`
    case 'LlmTransportError':
      return `Could not reach the model at ${error.url}${
        error.status === undefined ? '' : ` (HTTP ${error.status})`
      }: ${error.message}`
    case 'ModelLacksToolSupport':
      return `The model "${error.model}" has no native tool-calling support: ${error.hostMessage}`
    case 'EmptyModelResponse':
      return error.hadReasoning
        ? `"${error.model}" spent step ${error.step} reasoning and returned no answer, twice`
        : `"${error.model}" returned neither text nor a tool call at step ${error.step}, twice`
    case 'LlmProtocolError':
      return `The model returned something unusable: ${error.message}`
    case 'LlmTimeout':
      return `The model did not respond within ${error.timeoutMs} ms`
    case 'StepLimitExceeded':
      return `Turn ${error.turnId} hit the ${error.limit}-step limit`
    case 'ConfigError':
      return `Configuration variable ${error.variable} is invalid (${error.expected}); got "${error.value}"`
  }
}

/**
 * What to actually do about it. Kept separate from describeError because the
 * remedy is advice that changes with the environment, while the description is
 * a statement of fact (R5.13).
 */
export const remedyFor = (error: AppError): string | undefined => {
  switch (error._tag) {
    case 'AdapterUnsupported':
      return 'Force the in-memory adapter with ?adapter=in-memory, or use a browser that ships WebMCP.'
    case 'ToolRegistrationError':
      return 'The host message above is verbatim. If it mentions an unknown field, the WebMCP draft has probably moved — add an adapter (docs/adding-an-adapter.md).'
    case 'DuplicateToolName':
      return 'Disable one of the listed tool sets, or rename the tool in its module.'
    case 'ToolInputInvalid':
      return 'The model sent the wrong shape. Check the published JSON Schema in the selector pane.'
    case 'ToolTimeout':
      return 'Raise the per-call timeout, or check whether the tool is waiting on something that never settles.'
    case 'ToolHostUnavailable':
      return 'Reload the page, or force the in-memory adapter with ?adapter=in-memory.'
    case 'LlmTransportError':
      return 'Is the local endpoint running? Try `ollama serve`, or switch to the scripted driver — it needs no LLM.'
    case 'ModelLacksToolSupport':
      return 'Switch the tool-call strategy to "prompted" in the selector — it describes the tools in the prompt instead, which works with any model. Or choose a model with a tool template.'
    case 'EmptyModelResponse':
      return 'A thinking model can reason its way to a decision and then not state it. The loop already asked a second time, so this one is persistent: switch to the native strategy, or use a model that answers outside its reasoning channel.'
    case 'LlmProtocolError':
      return 'If the tool-call strategy is "prompted", this model may not follow the JSON format. Try the native strategy or a different model.'
    case 'LlmTimeout':
      return 'Raise LLM_TIMEOUT_MS, or use a smaller model.'
    case 'StepLimitExceeded':
      return 'Raise the step limit in the selector pane, or check whether a tool keeps failing and the model keeps retrying it.'
    case 'ConfigError':
      return 'Fix the variable in .env — see .env.example for the expected form.'
    case 'ToolNotFound':
    case 'ToolExecutionError':
    case 'ToolAborted':
      return undefined
  }
}
