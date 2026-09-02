import { Effect } from 'effect'
import type { ChatMessage, ToolCallRecord, Turn } from '../domain/chat'
import { EmptyModelResponse, describeError, remedyFor, type AppError } from '../domain/errors'
import type { IdFactory, TurnId } from '../domain/ids'
import type { HostTool, PublishedTool, ToolResult } from '../domain/tool'
import type { ToolHostService } from '../ports/ToolHost'
import type { LlmClientService, ToolCallStrategy } from '../ports/LlmClient'
import type { TraceSinkService } from '../ports/TraceSink'

/**
 * The turn lifecycle (R1.1, R1.4). It runs in the browser because WebMCP tools
 * do (ADR-1): a server-side loop would need a round trip per tool call and
 * would split the trace across two processes.
 *
 * The loop never fails. Every outcome — success, model failure, cancellation,
 * step limit — is a Turn value with a state, because the transcript must render
 * either way and a thrown error at this level would take the trace's own record
 * of what happened with it.
 */

export interface TurnDeps {
  readonly host: ToolHostService
  readonly client: LlmClientService
  readonly sink: TraceSinkService
  readonly ids: IdFactory
  readonly model: string
  readonly strategy: ToolCallStrategy
  readonly maxSteps: number
  readonly signal: AbortSignal
}

const toPublished = (tool: HostTool): PublishedTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema ?? { type: 'object' },
})

const isBlank = (text: string | null | undefined): boolean =>
  text === null || text === undefined || text.trim() === ''

/**
 * The prod sent when a model replies with nothing at all.
 *
 * A thinking model can spend its whole turn in the `reasoning` channel, work
 * out what to do, and then stop without saying it. Measured against
 * `gemma4:e4b` in prompted mode: 7 of 36 asks came back with empty content —
 * every one with `finish_reason: "stop"`, so this is the model ending its turn
 * rather than exhausting an output budget. Repeating the instruction it
 * reasoned past, and telling it not to think again, recovered all 7.
 *
 * Worded per strategy because "the JSON block" is the answer in prompted mode
 * (see `buildPromptedSystemMessage`) and nonsense in native mode. Only prompted
 * mode was measured; native shares the recovery because the failure is the
 * model's, not the strategy's.
 */
export const emptyResponseNudge = (strategy: ToolCallStrategy): string =>
  'Your previous reply contained no answer. Reply now with ' +
  (strategy === 'prompted'
    ? 'only the JSON tool-call block, or a plain-text answer'
    : 'your answer, or a tool call') +
  '. Do not think further.'

const flattenResult = (result: ToolResult): string => {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((block) => block.text).join('\n')
  // A malformed result must still produce something the model can read, or a
  // misbehaving tool would silently derail the conversation (debug.invalid_output).
  return text === '' ? JSON.stringify(result) : text
}

const abortSignalEffect = (signal: AbortSignal) =>
  Effect.async<'aborted'>((resume) => {
    const onAbort = () => resume(Effect.succeed('aborted' as const))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })

export const runTurn = (
  turnId: TurnId,
  history: ReadonlyArray<ChatMessage>,
  userMessage: string,
  deps: TurnDeps,
): Effect.Effect<Turn> => {
  const startedAt = Date.now()

  const base: Turn = {
    id: turnId,
    state: 'running',
    userMessage,
    steps: 0,
    messages: [...history, { role: 'user', content: userMessage }],
    toolCalls: [],
    finalText: null,
    startedAt,
  }

  const finish = (turn: Turn): Turn => ({ ...turn, endedAt: Date.now() })

  const failed = (turn: Turn, error: AppError): Effect.Effect<Turn> =>
    deps.sink
      .emit(
        {
          kind: 'TurnFailed',
          errorTag: error._tag,
          message: describeError(error),
          remedy: remedyFor(error),
        },
        { turnId },
      )
      .pipe(
        Effect.as(
          finish({
            ...turn,
            state: 'failed',
            errorTag: error._tag,
            errorMessage: describeError(error),
            remedy: remedyFor(error),
          }),
        ),
      )

  /**
   * One traced model request. Returns the completion or the error rather than
   * failing, because at this level "the model errored" is a turn outcome, and
   * because a step may need to ask twice.
   */
  const ask = (
    messages: ReadonlyArray<ChatMessage>,
    tools: ReadonlyArray<PublishedTool>,
    step: number,
  ) =>
    Effect.gen(function* () {
      const requestId = deps.ids.newRequestId()
      yield* deps.sink.emit(
        {
          kind: 'ModelRequested',
          driverId: deps.client.id,
          model: deps.model,
          strategy: deps.strategy,
          step,
          messageCount: messages.length,
          tools,
          request: { messages },
        },
        { turnId, requestId },
      )

      const started = performance.now()
      const completion = yield* Effect.either(
        deps.client.complete({
          model: deps.model,
          messages,
          tools,
          strategy: deps.strategy,
          signal: deps.signal,
          requestId,
        }),
      )
      const durationMs = Math.round(performance.now() - started)

      if (completion._tag === 'Left') return completion

      const response = completion.right
      yield* deps.sink.emit(
        {
          kind: 'ModelResponded',
          text: response.text,
          reasoning: response.reasoning ?? null,
          toolCalls: response.toolCalls,
          raw: response.raw,
        },
        { turnId, requestId, durationMs },
      )

      if (response.parseFailure !== undefined) {
        yield* deps.sink.emit(
          {
            kind: 'ToolCallParseFailed',
            reason: response.parseFailure.reason,
            text: response.parseFailure.text,
          },
          { turnId, requestId },
        )
      }

      return completion
    })

  const loop = Effect.gen(function* () {
    yield* deps.sink.emit({ kind: 'TurnStarted', userMessage }, { turnId })

    let turn = base

    for (let step = 1; step <= deps.maxSteps; step++) {
      // Re-read from the host every step rather than caching. Microseconds
      // slower, and it means a tool set toggled mid-turn behaves correctly and
      // the trace shows exactly what the model was offered each time (R2.4).
      const hostTools = yield* Effect.either(deps.host.listTools())
      if (hostTools._tag === 'Left') {
        // A host-level failure is the one thing that aborts a turn: if we cannot
        // see the tools, continuing would be guesswork (ADR-7).
        return yield* failed(turn, hostTools.left)
      }

      const tools = hostTools.right.map(toPublished)
      yield* deps.sink.emit(
        { kind: 'ToolsListed', tools: tools.map((t) => t.name), source: 'host' },
        { turnId },
      )

      const first = yield* ask(turn.messages, tools, step)
      if (first._tag === 'Left') {
        return yield* failed({ ...turn, steps: step }, first.left)
      }

      let response = first.right

      // A thinking model can spend the whole turn in its `reasoning` channel,
      // work out what to do, and then stop without saying it. Measured against
      // gemma4:e4b in prompted mode: 7 of 36 asks came back empty, every one
      // with finish_reason "stop" rather than a truncated budget — and one
      // re-ask carrying the nudge recovered all 7.
      //
      // Re-asking is safe precisely here and nowhere else in this codebase: an
      // empty reply named no tool, so nothing ran and there is no side effect
      // to double (contrast the deliberate no-retry in server/upstream.ts).
      if (response.toolCalls.length === 0 && isBlank(response.text)) {
        yield* deps.sink.emit(
          {
            kind: 'EmptyResponseRetried',
            step,
            hadReasoning: !isBlank(response.reasoning),
          },
          { turnId },
        )

        // The nudge prods this one request only; it never enters the
        // transcript, or every later step would carry the scolding with it.
        const retry = yield* ask(
          [...turn.messages, { role: 'system', content: emptyResponseNudge(deps.strategy) }],
          tools,
          step,
        )
        if (retry._tag === 'Left') {
          return yield* failed({ ...turn, steps: step }, retry.left)
        }
        response = retry.right
      }

      if (response.toolCalls.length === 0) {
        // No tool call AND no text is not an answer, it is an empty response.
        // Completing here would show the user a blank turn and call it success.
        if (isBlank(response.text)) {
          return yield* failed(
            { ...turn, steps: step },
            new EmptyModelResponse({
              model: deps.model,
              step,
              hadReasoning: !isBlank(response.reasoning),
            }),
          )
        }

        yield* deps.sink.emit(
          { kind: 'TurnCompleted', steps: step, finalText: response.text },
          { turnId },
        )
        return finish({ ...turn, state: 'completed', steps: step, finalText: response.text })
      }

      const messages: ChatMessage[] = [
        ...turn.messages,
        { role: 'assistant', content: response.text, toolCalls: response.toolCalls },
      ]
      const records: ToolCallRecord[] = [...turn.toolCalls]

      for (const call of response.toolCalls) {
        const callId = deps.ids.newCallId()
        const callStarted = performance.now()
        const outcome = yield* Effect.either(
          deps.host.execute(call.name, call.input, { signal: deps.signal }),
        )
        const callDuration = Math.round(performance.now() - callStarted)

        if (outcome._tag === 'Right') {
          const text = flattenResult(outcome.right)
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: text })
          records.push({
            callId,
            requestId: call.id,
            name: call.name,
            input: call.input,
            result: outcome.right,
            durationMs: callDuration,
            startedAt: Date.now() - callDuration,
          })
        } else {
          const error = outcome.left
          // Tool failures go back to the model as results, not up as errors.
          // That is how real agents behave, and it is what exercises recovery
          // rather than pretending failure never happens (ADR-7).
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: `Error (${error._tag}): ${describeError(error)}`,
          })
          records.push({
            callId,
            requestId: call.id,
            name: call.name,
            input: call.input,
            errorTag: error._tag,
            errorMessage: describeError(error),
            durationMs: callDuration,
            startedAt: Date.now() - callDuration,
          })
        }
      }

      turn = { ...turn, steps: step, messages, toolCalls: records }
    }

    // A guard, not an error condition: the transcript renders in full, flagged.
    yield* deps.sink.emit(
      {
        kind: 'TurnFailed',
        errorTag: 'StepLimitExceeded',
        message: `Turn ${turnId} hit the ${deps.maxSteps}-step limit`,
        remedy: 'Raise the step limit, or check whether a tool keeps failing and the model keeps retrying it.',
      },
      { turnId },
    )
    return finish({
      ...turn,
      state: 'step_limit_exceeded',
      errorTag: 'StepLimitExceeded',
      errorMessage: `Stopped after ${deps.maxSteps} steps.`,
      remedy: 'Raise the step limit in the selector pane.',
    })
  })

  const cancelled = abortSignalEffect(deps.signal).pipe(
    Effect.flatMap(() => deps.sink.emit({ kind: 'TurnCancelled' }, { turnId })),
    Effect.as(finish({ ...base, state: 'cancelled' })),
  )

  // One controller aborts the model request and any running tool alike (R1.3);
  // racing here also unblocks a driver that ignores its signal.
  return Effect.raceFirst(loop, cancelled)
}
