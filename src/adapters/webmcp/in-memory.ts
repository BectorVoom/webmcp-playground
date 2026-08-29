import { Effect } from 'effect'
import { publishSchema } from '../../domain/schema'
import { ToolNotFound, ToolRegistrationError } from '../../domain/errors'
import type { AnyToolDefinition, HostTool } from '../../domain/tool'
import type { AdapterId, SpecRevision, ToolHostService } from '../../ports/ToolHost'
import type { ToolRunner } from '../../ports/ToolRunner'
import type { TraceSinkService } from '../../ports/TraceSink'
import {
  errorFromHostRejection,
  resultFromHostValue,
  validateRegistration,
} from './host-boundary'

const ID: AdapterId = 'in-memory'

const REVISION: SpecRevision = {
  label: 'in-memory reference host',
  url: 'https://webmachinelearning.github.io/webmcp/',
}

/**
 * A peer of the real adapters, not a test double (ADR-2).
 *
 * It ships in production code and can be selected at runtime, which buys three
 * things: the app is fully exercisable in browsers with no WebMCP at all; the
 * conformance suite gets a reference implementation to compare against; and
 * when a real adapter misbehaves there is a known-good control one query
 * parameter away.
 *
 * It deliberately routes execution through the same promise-and-string boundary
 * the real hosts impose, rather than calling tool bodies directly. A reference
 * implementation that skipped the lossy part would not be a reference for the
 * thing that actually breaks.
 */
export const makeInMemoryHost = (
  runner: ToolRunner,
  sink: TraceSinkService,
): ToolHostService => {
  const tools = new Map<string, AnyToolDefinition>()
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const toHostTool = (tool: AnyToolDefinition): HostTool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: publishSchema(tool),
    annotations: tool.annotations,
  })

  return {
    id: ID,
    specRevision: REVISION,

    register: (tool) =>
      Effect.gen(function* () {
        yield* validateRegistration(tool, ID)
        if (tools.has(tool.name)) {
          return yield* Effect.fail(
            new ToolRegistrationError({
              tool: tool.name,
              adapter: ID,
              hostMessage: `A tool named "${tool.name}" is already registered`,
            }),
          )
        }
        tools.set(tool.name, tool)
        yield* sink.emit({
          kind: 'ToolRegistered',
          tool: tool.name,
          adapterId: ID,
          jsonSchema: publishSchema(tool),
        })
        notify()
        return {
          unregister: Effect.sync(() => {
            tools.delete(tool.name)
            notify()
          }),
        }
      }),

    listTools: () => Effect.sync(() => [...tools.values()].map(toHostTool)),

    execute: (name, input, options) =>
      Effect.suspend(() => {
        const tool = tools.get(name)
        if (tool === undefined) {
          return Effect.fail(new ToolNotFound({ tool: name, known: [...tools.keys()] }))
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
