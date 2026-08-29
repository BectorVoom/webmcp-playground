import { Effect } from 'effect'
import { publishSchema } from '../../domain/schema'
import { ToolNotFound, ToolRegistrationError } from '../../domain/errors'
import type { AnyToolDefinition, HostTool } from '../../domain/tool'
import type { AdapterId, SpecRevision, ToolHostService } from '../../ports/ToolHost'
import type { ToolRunner } from '../../ports/ToolRunner'
import type { TraceSinkService } from '../../ports/TraceSink'
import type { LegacyModelContext } from './spec-types'
import {
  errorFromHostRejection,
  hostMessageOf,
  resultFromHostValue,
  validateRegistration,
} from './host-boundary'

const ID: AdapterId = 'legacy-navigator'

const REVISION: SpecRevision = {
  label: 'superseded navigator.modelContext.provideContext',
  url: 'https://github.com/webmachinelearning/webmcp',
}

/**
 * Adapter for the superseded whole-set-replacement API.
 *
 * This adapter is not here for compatibility — it is here for pressure (ADR-5).
 * Its host differs from the current draft in three ways that would each be a
 * refactor if ToolHostPort had been shaped around the 2026-04 draft alone:
 *
 *   - registration replaces the entire tool set, so there is no per-tool handle
 *     and unregistration means re-providing the set without that tool;
 *   - there is no guaranteed read-back, so `listTools` may only be able to
 *     report our own mirror — which it says out loud rather than pretending;
 *   - there is no host-side execute, so invocation goes straight to the runner.
 *
 * If the port can express both this and the current draft, it can probably
 * express whatever comes next (R6.6).
 */
export const makeLegacyHost = (
  modelContext: LegacyModelContext,
  runner: ToolRunner,
  sink: TraceSinkService,
): ToolHostService => {
  const mirror = new Map<string, AnyToolDefinition>()
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const provide = () =>
    Effect.tryPromise({
      try: async () =>
        modelContext.provideContext({
          tools: [...mirror.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: publishSchema(tool),
            execute: (input: object) => runner.executeAsPromise(tool, input, { signal: neverAbort() }),
          })),
        }),
      catch: (cause) => cause,
    })

  // The legacy execute callback carries no signal, so a tool invoked by a real
  // legacy agent cannot be cancelled. Rather than fake one, we hand it a signal
  // that never aborts and let the timeout be the only bound — the honest
  // representation of what that API could actually do.
  const neverAbort = (): AbortSignal => new AbortController().signal

  return {
    id: ID,
    specRevision: REVISION,

    register: (tool) =>
      Effect.gen(function* () {
        yield* validateRegistration(tool, ID)
        if (mirror.has(tool.name)) {
          return yield* Effect.fail(
            new ToolRegistrationError({
              tool: tool.name,
              adapter: ID,
              hostMessage: `A tool named "${tool.name}" is already registered`,
            }),
          )
        }
        mirror.set(tool.name, tool)

        yield* provide().pipe(
          Effect.mapError((cause) => {
            mirror.delete(tool.name)
            return new ToolRegistrationError({
              tool: tool.name,
              adapter: ID,
              hostMessage: hostMessageOf(cause),
              cause,
            })
          }),
        )

        yield* sink.emit({
          kind: 'ToolRegistered',
          tool: tool.name,
          adapterId: ID,
          jsonSchema: publishSchema(tool),
        })
        notify()

        return {
          unregister: Effect.gen(function* () {
            mirror.delete(tool.name)
            yield* provide().pipe(Effect.ignore)
            notify()
          }),
        }
      }),

    listTools: () =>
      Effect.gen(function* () {
        const fromHost = modelContext.getTools
        if (fromHost !== undefined) {
          const tools = yield* Effect.tryPromise({
            try: async () => fromHost.call(modelContext),
            catch: (cause) => cause,
          }).pipe(Effect.orElseSucceed(() => undefined))

          if (tools !== undefined) {
            return tools.map(
              (tool): HostTool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              }),
            )
          }
        }
        return [...mirror.values()].map(
          (tool): HostTool => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: publishSchema(tool),
            annotations: tool.annotations,
          }),
        )
      }),

    execute: (name, input, options) =>
      Effect.suspend(() => {
        const tool = mirror.get(name)
        if (tool === undefined) {
          return Effect.fail(new ToolNotFound({ tool: name, known: [...mirror.keys()] }))
        }
        return Effect.tryPromise({
          try: () => runner.executeAsPromise(tool, input, { signal: options.signal }),
          catch: (cause) => errorFromHostRejection(name, cause),
        }).pipe(Effect.map(resultFromHostValue))
      }),

    subscribeToChanges: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Whether this adapter can read tools back from the host, or only mirror them. */
export const legacyReadbackSource = (modelContext: LegacyModelContext): 'host' | 'mirror' =>
  modelContext.getTools === undefined ? 'mirror' : 'host'
