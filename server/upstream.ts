import { Effect, Schedule } from 'effect'
import {
  LlmProtocolError,
  LlmTimeout,
  LlmTransportError,
  ModelLacksToolSupport,
} from '../src/domain/errors'
import type { ChatProxyRequest, ChatProxyResponse } from '../src/domain/wire'
import type { ServerConfig } from './config'

/**
 * The only place that speaks OpenAI's wire format. Keeping the dialect here
 * means swapping to a differently-shaped local server is one file, and the
 * browser keeps talking in the application's own terms.
 */

interface OpenAiToolCall {
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

interface OpenAiChoice {
  readonly message?: {
    readonly content?: string | null
    // Ollama uses `reasoning`; vLLM and some others use `reasoning_content`.
    readonly reasoning?: string | null
    readonly reasoning_content?: string | null
    readonly tool_calls?: ReadonlyArray<OpenAiToolCall>
  }
}

interface OpenAiCompletion {
  readonly choices?: ReadonlyArray<OpenAiChoice>
  readonly model?: string
}

const authHeaders = (config: ServerConfig): Record<string, string> =>
  config.llmApiKey === undefined ? {} : { authorization: `Bearer ${config.llmApiKey}` }

/**
 * Retries transport-level failures only. A response the model has already begun
 * producing is never retried: re-asking for it wastes a slow local generation
 * and can double side effects if tools were already called (R4.8).
 */
const retryPolicy = Schedule.exponential('250 millis').pipe(
  Schedule.compose(Schedule.recurs(2)),
)

/**
 * Ollama (and llama.cpp) reject a `tools` request for a model whose template has
 * no tool support, with a message naming the model. Recognising it here turns an
 * opaque 400 into the one piece of advice that actually helps.
 */
const TOOLS_UNSUPPORTED = /does not support tools/i

const fetchJson = (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  model?: string,
): Effect.Effect<
  unknown,
  LlmTransportError | LlmProtocolError | LlmTimeout | ModelLacksToolSupport
> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchImpl(url, { ...init, signal }),
      catch: (cause) =>
        new LlmTransportError({
          url,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.retry({ schedule: retryPolicy, while: (e) => e._tag === 'LlmTransportError' }))

    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text().catch(() => ''))

      if (model !== undefined && TOOLS_UNSUPPORTED.test(body)) {
        return yield* Effect.fail(
          new ModelLacksToolSupport({ model, hostMessage: body.slice(0, 400) }),
        )
      }

      // A non-2xx status is a decision the server made, not a flaky connection:
      // retrying it would only make the same mistake more slowly.
      return yield* Effect.fail(
        new LlmTransportError({
          url,
          status: response.status,
          message: body.slice(0, 400) || response.statusText,
        }),
      )
    }

    const text = yield* Effect.promise(() => response.text())
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new LlmProtocolError({
          message: 'Upstream returned a body that is not JSON',
          bodyExcerpt: text.slice(0, 400),
        }),
    })
  }).pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => new LlmTimeout({ timeoutMs }),
    }),
  )

export const listModels = (config: ServerConfig, timeoutMs = 3000, fetchImpl: typeof fetch = fetch) =>
  fetchJson(`${config.llmBaseUrl}/models`, { headers: authHeaders(config) }, timeoutMs, fetchImpl).pipe(
    Effect.map((body) => {
      const data = (body as { data?: ReadonlyArray<{ id?: string }> }).data ?? []
      return data.flatMap((entry) => (entry.id === undefined ? [] : [{ id: entry.id }]))
    }),
  )

const toOpenAiMessages = (request: ChatProxyRequest): ReadonlyArray<unknown> =>
  request.messages.map((message) => {
    switch (message.role) {
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls === undefined || message.toolCalls.length === 0
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              }),
        }
      default:
        return { role: message.role, content: message.content }
    }
  })

const parseArguments = (raw: string | undefined): unknown => {
  if (raw === undefined || raw.trim() === '') return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Local models routinely emit not-quite-JSON arguments. Preserving the raw
    // string lets the browser show what actually arrived instead of an
    // unhelpful "invalid input".
    return { __unparsed: raw }
  }
}

export const chatCompletion = (
  config: ServerConfig,
  request: ChatProxyRequest,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<
  ChatProxyResponse,
  LlmTransportError | LlmProtocolError | LlmTimeout | ModelLacksToolSupport
> =>
  fetchJson(
    `${config.llmBaseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(config) },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAiMessages(request),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        stream: false,
      }),
    },
    config.llmTimeoutMs,
    fetchImpl,
    request.model,
  ).pipe(
    Effect.map((raw): ChatProxyResponse => {
      const completion = raw as OpenAiCompletion
      const message = completion.choices?.[0]?.message
      const toolCalls = (message?.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? 'unknown',
        input: parseArguments(call.function?.arguments),
      }))
      // Normalise an empty string to null: a thinking model returns content ""
      // alongside tool calls, and "" is not a final answer.
      const content = message?.content
      return {
        text: content === undefined || content === '' ? null : content,
        reasoning: message?.reasoning ?? message?.reasoning_content ?? null,
        toolCalls,
        raw,
        requestId,
        model: completion.model ?? request.model,
      }
    }),
  )
