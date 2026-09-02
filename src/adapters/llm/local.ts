import { Effect } from 'effect'
import {
  LlmProtocolError,
  LlmTimeout,
  LlmTransportError,
  ModelLacksToolSupport,
} from '../../domain/errors'
import {
  REQUEST_ID_HEADER,
  type ChatProxyErrorBody,
  type ChatProxyResponse,
  type ModelsResponse,
} from '../../domain/wire'
import type {
  CompletionError,
  CompletionRequest,
  CompletionResponse,
  LlmClientService,
} from '../../ports/LlmClient'
import { parsePromptedResponse, withPromptedTools } from './tool-call'

/**
 * The real driver. It never talks to the model directly: everything goes
 * through the Hono backend, so the browser never holds a credential and the
 * OpenAI dialect stays in one place (R4.2).
 */

const API_BASE = '/api'

const transportError = (message: string, status?: number) =>
  new LlmTransportError({ url: `${API_BASE}/llm/chat`, status, message })

const readJson = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () =>
      new LlmProtocolError({
        message: 'The backend returned a body that is not JSON',
        bodyExcerpt: `HTTP ${response.status}`,
      }),
  })

export const makeLocalClient = (
  model: string,
  fetchImpl: typeof fetch = fetch,
): LlmClientService => ({
  id: 'local',

  listModels: () =>
    Effect.tryPromise({
      try: () => fetchImpl(`${API_BASE}/llm/models`),
      catch: (cause) =>
        new LlmTransportError({
          url: `${API_BASE}/llm/models`,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<ModelsResponse>,
          catch: () =>
            new LlmTransportError({
              url: `${API_BASE}/llm/models`,
              message: 'Model list was not JSON',
            }),
        }),
      ),
      Effect.map((body) => body.models),
    ),

  complete: (request: CompletionRequest): Effect.Effect<CompletionResponse, CompletionError> =>
    Effect.gen(function* () {
      const prompted = request.strategy === 'prompted'
      const messages = prompted ? withPromptedTools(request.messages, request.tools) : request.messages

      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${API_BASE}/llm/chat`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [REQUEST_ID_HEADER]: request.requestId,
            },
            signal: request.signal,
            body: JSON.stringify({
              model: request.model || model,
              messages,
              // The prompted strategy carries tools in the system message, so
              // sending them again would double the token cost for nothing.
              ...(prompted ? {} : { tools: request.tools }),
            }),
          }),
        catch: (cause) =>
          transportError(cause instanceof Error ? cause.message : String(cause)),
      })

      const body = yield* readJson(response)

      if (!response.ok) {
        // The backend has already classified this and sends the error's own
        // fields alongside its tag, so the reconstruction here is faithful
        // rather than a tag with the details rubbed off (R6.8).
        const error = body as Partial<ChatProxyErrorBody>
        if (error.error === 'ModelLacksToolSupport') {
          return yield* Effect.fail(
            new ModelLacksToolSupport({
              model: request.model || model,
              hostMessage: error.hostMessage ?? error.message ?? '',
            }),
          )
        }
        if (error.error === 'LlmTimeout') {
          return yield* Effect.fail(new LlmTimeout({ timeoutMs: error.timeoutMs ?? 0 }))
        }
        if (error.error === 'LlmProtocolError') {
          return yield* Effect.fail(
            new LlmProtocolError({
              message: error.message ?? 'Upstream protocol error',
              bodyExcerpt: error.bodyExcerpt ?? '',
            }),
          )
        }
        return yield* Effect.fail(
          transportError(error.message ?? `HTTP ${response.status}`, response.status),
        )
      }

      const proxied = body as ChatProxyResponse

      if (!prompted) {
        return {
          text: proxied.text,
          reasoning: proxied.reasoning,
          toolCalls: proxied.toolCalls,
          raw: proxied.raw,
          requestId: request.requestId,
        }
      }

      const parsed = parsePromptedResponse(proxied.text)
      return {
        text: parsed.text,
        reasoning: proxied.reasoning,
        toolCalls: parsed.toolCalls,
        raw: proxied.raw,
        requestId: request.requestId,
        ...(parsed.parseFailure === undefined ? {} : { parseFailure: parsed.parseFailure }),
      }
    }),
})
