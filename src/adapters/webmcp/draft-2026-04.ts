import { Effect } from 'effect'
import { publishSchema } from '../../domain/schema'
import {
  errorFromToolBoundaryResult,
  resultForToolBoundaryError,
} from '../../domain/tool-boundary'
import { ToolNotFound, ToolHostUnavailable, ToolRegistrationError } from '../../domain/errors'
import type { HostTool } from '../../domain/tool'
import type { AdapterId, SpecRevision, ToolHostService } from '../../ports/ToolHost'
import type { ToolRunner } from '../../ports/ToolRunner'
import type { TraceSinkService } from '../../ports/TraceSink'
import type { DraftModelContext, DraftRegisteredTool } from './spec-types'
import {
  errorFromHostRejection,
  hostMessageOf,
  resultFromHostValue,
  schemaFromHostValue,
  validateRegistration,
} from './host-boundary'
import { fromChangeSubscription } from './change-stream'

const ID: AdapterId = 'draft-2026-04'

const REVISION: SpecRevision = {
  label: 'W3C CG Draft Report, 2026-08-26 (Origin Trial compatible)',
  url: 'https://webmachinelearning.github.io/webmcp/',
}

/**
 * Adapter for the current `document.modelContext` API and the measured Chrome/Edge Origin Trial.
 *
 * Two spec details are worth noting because they shape the code:
 *
 * 1. `registerTool` takes an AbortSignal and there is no `unregisterTool`.
 *    Unregistration is abortion of the registration, which is why the handle
 *    closes over a controller rather than calling a removal method.
 * 2. `executeTool()` is specified to resolve to a stringified result, while the
 *    same document's `execute` callback returns content blocks. We send content
 *    blocks and accept either coming back (see resultFromHostValue).
 */
export const makeDraftHost = (
  modelContext: DraftModelContext,
  runner: ToolRunner,
  sink: TraceSinkService,
): ToolHostService => {
  const changes = fromChangeSubscription((listener) => {
    modelContext.addEventListener('toolchange', listener)
    return () => modelContext.removeEventListener('toolchange', listener)
  })

  const findRegistered = (
    name: string,
  ): Effect.Effect<DraftRegisteredTool, ToolNotFound | ToolHostUnavailable> =>
    Effect.tryPromise({
      try: () => modelContext.getTools(),
      catch: (cause) => new ToolHostUnavailable({ adapter: ID, detail: hostMessageOf(cause) }),
    }).pipe(
      Effect.flatMap((tools) => {
        const found = tools.find((tool) => tool.name === name)
        return found === undefined
          ? Effect.fail(new ToolNotFound({ tool: name, known: tools.map((t) => t.name) }))
          : Effect.succeed(found)
      }),
    )

  return {
    id: ID,
    specRevision: REVISION,

    register: (tool) =>
      Effect.gen(function* () {
        yield* validateRegistration(tool, ID)
        const controller = new AbortController()
        const jsonSchema = publishSchema(tool)

        yield* Effect.tryPromise({
          try: () =>
            modelContext.registerTool(
              {
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: jsonSchema,
                annotations: {
                  readOnlyHint: tool.annotations.readOnlyHint,
                  untrustedContentHint: tool.annotations.untrustedContentHint,
                },
                // Shipping hosts call this with one argument and no signal, so
                // the fallback is the normal path rather than defensive
                // padding. Without it every host-driven invocation throws on
                // `options.signal` before the tool body is reached.
                execute: async (input, options) => {
                  try {
                    return await runner.executeAsPromise(tool, input, {
                      signal: options?.signal ?? new AbortController().signal,
                    })
                  } catch (cause) {
                    // Chrome and Edge replace any rejected callback promise with
                    // one opaque DOMException. Fulfil a marked error result
                    // instead; stringification preserves its typed fields.
                    const result = resultForToolBoundaryError(cause)
                    if (result !== undefined) return result
                    throw cause
                  }
                },
              },
              { signal: controller.signal },
            ),
          catch: (cause) =>
            new ToolRegistrationError({
              tool: tool.name,
              adapter: ID,
              // Verbatim, because a host complaining about an unknown field is
              // how we learn the draft moved (R6.8).
              hostMessage: hostMessageOf(cause),
              cause,
            }),
        })

        yield* sink.emit({ kind: 'ToolRegistered', tool: tool.name, adapterId: ID, jsonSchema })

        return { unregister: Effect.sync(() => controller.abort()) }
      }),

    listTools: () =>
      Effect.tryPromise({
        try: () => modelContext.getTools(),
        catch: (cause) => new ToolHostUnavailable({ adapter: ID, detail: hostMessageOf(cause) }),
      }).pipe(
        Effect.map((tools): ReadonlyArray<HostTool> =>
          tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: schemaFromHostValue(tool.inputSchema),
            annotations:
              tool.annotations === undefined
                ? undefined
                : {
                    readOnlyHint: tool.annotations.readOnlyHint ?? false,
                    untrustedContentHint: tool.annotations.untrustedContentHint ?? false,
                  },
          })),
        ),
      ),

    execute: (name, input, options) =>
      findRegistered(name).pipe(
        Effect.catchTag('ToolHostUnavailable', (error) =>
          Effect.fail(new ToolNotFound({ tool: name, known: [`(host unavailable: ${error.detail})`] })),
        ),
        Effect.flatMap((registered) =>
          Effect.tryPromise({
            // Early Origin Trial hosts take JSON text; the August draft takes an object. Try the
            // deployed form first. A current Web IDL binding rejects that primitive with TypeError
            // before invocation, which is the only safe time to retry — catching arbitrary tool
            // failures here could run a side-effecting tool twice.
            try: async () => {
              const value = input !== null && typeof input === 'object' ? input : {}
              try {
                return await modelContext.executeTool(registered, JSON.stringify(value), options)
              } catch (cause) {
                if (!(cause instanceof TypeError)) throw cause
                return modelContext.executeTool(registered, value, options)
              }
            },
            catch: (cause) => errorFromHostRejection(name, cause),
          }),
        ),
        Effect.flatMap((raw) => {
          const result = resultFromHostValue(raw)
          const error = errorFromToolBoundaryResult(name, result)
          return error === undefined ? Effect.succeed(result) : Effect.fail(error)
        }),
      ),

    changes,
  }
}
