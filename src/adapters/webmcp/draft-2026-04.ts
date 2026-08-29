import { Effect } from 'effect'
import { publishSchema } from '../../domain/schema'
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
  validateRegistration,
} from './host-boundary'

const ID: AdapterId = 'draft-2026-04'

const REVISION: SpecRevision = {
  label: 'W3C CG Draft Report, 2026-04-23',
  url: 'https://webmachinelearning.github.io/webmcp/',
}

/**
 * Adapter for `document.modelContext` as specified in the April 2026 draft.
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
  const listeners = new Set<() => void>()
  const onToolChange = () => {
    for (const listener of listeners) listener()
  }

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
                execute: (input, options) =>
                  runner.executeAsPromise(tool, input, { signal: options.signal }),
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
            inputSchema: tool.inputSchema,
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
            try: () => modelContext.executeTool(registered, input as object, options),
            catch: (cause) => errorFromHostRejection(name, cause),
          }),
        ),
        Effect.map(resultFromHostValue),
      ),

    subscribeToChanges: (listener) => {
      if (listeners.size === 0) modelContext.addEventListener('toolchange', onToolChange)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) modelContext.removeEventListener('toolchange', onToolChange)
      }
    },
  }
}
