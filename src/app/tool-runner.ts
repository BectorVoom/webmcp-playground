import { Cause, Effect, Exit } from 'effect'
import { decodeToolInput } from '../domain/schema'
import { ToolAborted, ToolExecutionError, ToolTimeout, describeError, type ToolError } from '../domain/errors'
import { ToolBoundaryError } from '../domain/tool-boundary'
import type { IdFactory, TurnId } from '../domain/ids'
import type { AnyToolDefinition, ToolResult } from '../domain/tool'
import type { ToolRunner, ToolRunOptions } from '../ports/ToolRunner'
import type { TraceSinkService } from '../ports/TraceSink'
import type { FaultInjector } from './fault-injector'

export interface ToolRunnerDeps {
  readonly sink: TraceSinkService
  readonly faults: FaultInjector
  readonly ids: IdFactory
  readonly timeoutMs: () => number
  readonly currentTurnId: () => TurnId | undefined
}

/** The shape a host sees when the `invalid` fault is armed: plausible, and wrong. */
const INVALID_RESULT = { content: 'not-an-array', unexpected: true } as unknown as ToolResult

const abortEffect = (signal: AbortSignal, toolName: string) =>
  Effect.async<never, ToolAborted>((resume) => {
    const onAbort = () => resume(Effect.fail(new ToolAborted({ tool: toolName })))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })

export const createToolRunner = (deps: ToolRunnerDeps): ToolRunner => {
  const executeEffect = (
    tool: AnyToolDefinition,
    rawInput: unknown,
    options: ToolRunOptions,
  ): Effect.Effect<ToolResult, ToolError> => {
    const callId = options.callId ?? deps.ids.newCallId()
    const turnId = options.turnId ?? deps.currentTurnId()
    const correlation = { callId, turnId }
    const timeoutMs = deps.timeoutMs()

    return Effect.gen(function* () {
      yield* deps.sink.emit({ kind: 'ToolCallStarted', tool: tool.name, input: rawInput }, correlation)

      // Validate before the body runs, always — a tool must never see input it
      // did not declare (R3.6).
      const input = yield* decodeToolInput(tool, rawInput)

      const fault = deps.faults.consume(tool.name)
      if (fault !== undefined) {
        yield* deps.sink.emit({ kind: 'FaultInjected', tool: tool.name, fault }, correlation)
      }

      const body: Effect.Effect<ToolResult, ToolError> =
        fault === 'fail'
          ? Effect.fail(
              new ToolExecutionError({ tool: tool.name, message: 'Injected fault: fail' }),
            )
          : fault === 'invalid'
            ? Effect.succeed(INVALID_RESULT)
            : fault === 'hang'
              ? Effect.never
              : tool.execute(input, { signal: options.signal, callId, turnId: turnId as TurnId })

      // The abort race and the timeout are separate on purpose: cancellation by
      // the user and exhaustion of a budget are different findings.
      const raced = Effect.raceFirst(body, abortEffect(options.signal, tool.name))

      const started = performance.now()
      const exit = yield* Effect.exit(
        raced.pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () => new ToolTimeout({ tool: tool.name, timeoutMs }),
          }),
          Effect.withSpan(`tool:${tool.name}`),
        ),
      )
      const durationMs = Math.round(performance.now() - started)

      if (Exit.isSuccess(exit)) {
        yield* deps.sink.emit(
          { kind: 'ToolCallCompleted', tool: tool.name, result: exit.value },
          { ...correlation, durationMs },
        )
        return exit.value
      }

      const failure = Cause.failureOption(exit.cause)
      const error: ToolError = failure._tag === 'Some'
        ? failure.value
        : new ToolExecutionError({
            tool: tool.name,
            message: Cause.pretty(exit.cause),
            cause: exit.cause,
          })

      yield* deps.sink.emit(
        { kind: 'ToolCallFailed', tool: tool.name, errorTag: error._tag, message: describeError(error) },
        { ...correlation, durationMs },
      )
      return yield* Effect.fail(error)
    }).pipe(
      // Input validation failure is reported the same way as any other tool
      // failure, so the inspector shows one consistent story per call.
      Effect.tapError((error) =>
        error._tag === 'ToolInputInvalid'
          ? deps.sink.emit(
              {
                kind: 'ToolCallFailed',
                tool: tool.name,
                errorTag: error._tag,
                message: describeError(error),
              },
              correlation,
            )
          : Effect.void,
      ),
    )
  }

  const executeAsPromise = async (
    tool: AnyToolDefinition,
    rawInput: unknown,
    options: ToolRunOptions,
  ): Promise<ToolResult> => {
    const exit = await Effect.runPromiseExit(executeEffect(tool, rawInput, options))
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Cause.failureOption(exit.cause)
    const error: ToolError =
      failure._tag === 'Some'
        ? failure.value
        : new ToolExecutionError({ tool: tool.name, message: Cause.pretty(exit.cause) })
    return Promise.reject(new ToolBoundaryError(error, describeError(error)))
  }

  return { executeEffect, executeAsPromise }
}
