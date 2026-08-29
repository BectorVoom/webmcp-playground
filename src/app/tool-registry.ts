import { Effect } from 'effect'
import { DuplicateToolName, describeError, type ToolRegistrationError } from '../domain/errors'
import type { AnyToolDefinition, ToolSet } from '../domain/tool'
import type { RegistrationHandle, ToolHostService } from '../ports/ToolHost'
import type { TraceSinkService } from '../ports/TraceSink'
import { createStore, type Store } from '../lib/store'

/**
 * Owns which tool sets are live, and the lifetime of every registration
 * (task 3.8, R2.2, R2.3, R2.6).
 *
 * Registrations unwind in reverse order on disable, on adapter switch, and on
 * reset — the same path in all three cases, so there is no "we forgot to clean
 * up on the unusual route" bug waiting to happen (R7.7).
 */

export interface ToolRegistrationStatus {
  readonly name: string
  readonly status: 'registered' | 'failed'
  readonly error?: string
}

export interface ToolSetStatus {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly toolCount: number
  readonly enabled: boolean
  readonly tools: ReadonlyArray<ToolRegistrationStatus>
}

export interface ToolRegistryManager {
  readonly status: Store<ReadonlyArray<ToolSetStatus>>
  readonly enabledIds: () => ReadonlyArray<string>
  readonly enable: (setId: string) => Effect.Effect<void, DuplicateToolName>
  readonly disable: (setId: string) => Effect.Effect<void>
  readonly setEnabled: (ids: ReadonlyArray<string>) => Effect.Effect<void, DuplicateToolName>
  /** Tear down every registration and re-register against a new host. */
  readonly rebindHost: (host: ToolHostService) => Effect.Effect<void>
  readonly disableAll: () => Effect.Effect<void>
}

interface LiveRegistration {
  readonly tool: AnyToolDefinition
  readonly handle: RegistrationHandle
}

export const createToolRegistryManager = (
  catalogue: ReadonlyArray<ToolSet>,
  initialHost: ToolHostService,
  sink: TraceSinkService,
): ToolRegistryManager => {
  let host = initialHost
  const live = new Map<string, ReadonlyArray<LiveRegistration>>()
  const failures = new Map<string, ReadonlyArray<ToolRegistrationStatus>>()

  const status = createStore<ReadonlyArray<ToolSetStatus>>([])

  const refreshStatus = () => {
    status.set(
      catalogue.map((set) => {
        const registrations = live.get(set.id)
        const recorded = failures.get(set.id)
        return {
          id: set.id,
          title: set.title,
          description: set.description,
          toolCount: set.tools.length,
          enabled: registrations !== undefined,
          tools: recorded ?? [],
        }
      }),
    )
  }

  const nameOwners = (): Map<string, string> => {
    const owners = new Map<string, string>()
    for (const [setId, registrations] of live) {
      for (const registration of registrations) owners.set(registration.tool.name, setId)
    }
    return owners
  }

  const registerSet = (set: ToolSet) =>
    Effect.gen(function* () {
      const registrations: LiveRegistration[] = []
      const outcomes: ToolRegistrationStatus[] = []

      for (const tool of set.tools) {
        const result = yield* Effect.either(host.register(tool))
        if (result._tag === 'Right') {
          registrations.push({ tool, handle: result.right })
          outcomes.push({ name: tool.name, status: 'registered' })
        } else {
          const error: ToolRegistrationError = result.left
          outcomes.push({ name: tool.name, status: 'failed', error: describeError(error) })
          yield* sink.emit({
            kind: 'ToolRegistrationFailed',
            tool: tool.name,
            adapterId: host.id,
            hostMessage: error.hostMessage,
          })
        }
      }

      live.set(set.id, registrations)
      failures.set(set.id, outcomes)
      yield* sink.emit({
        kind: 'ToolSetEnabled',
        toolSetId: set.id,
        tools: registrations.map((r) => r.tool.name),
      })
      refreshStatus()
    })

  const unregisterSet = (setId: string) =>
    Effect.gen(function* () {
      const registrations = live.get(setId)
      if (registrations === undefined) return
      // Reverse order: the last thing registered is the first thing released.
      for (const registration of [...registrations].reverse()) {
        yield* registration.handle.unregister
      }
      live.delete(setId)
      failures.delete(setId)
      yield* sink.emit({ kind: 'ToolSetDisabled', toolSetId: setId })
      refreshStatus()
    })

  const enable = (setId: string): Effect.Effect<void, DuplicateToolName> =>
    Effect.gen(function* () {
      const set = catalogue.find((s) => s.id === setId)
      if (set === undefined || live.has(setId)) return

      // Refuse before touching the host: a half-registered set is worse than a
      // refused one, and the conflict names both owners so it is actionable (R2.6).
      const owners = nameOwners()
      for (const tool of set.tools) {
        const owner = owners.get(tool.name)
        if (owner !== undefined) {
          return yield* Effect.fail(
            new DuplicateToolName({ tool: tool.name, owningSets: [owner, set.id] }),
          )
        }
      }

      yield* registerSet(set)
    })

  const disableAll = () =>
    Effect.forEach([...live.keys()].reverse(), unregisterSet, { discard: true })

  return {
    status,
    enabledIds: () => [...live.keys()],
    enable,
    disable: unregisterSet,
    setEnabled: (ids) =>
      Effect.gen(function* () {
        const wanted = new Set(ids)
        for (const setId of [...live.keys()]) {
          if (!wanted.has(setId)) yield* unregisterSet(setId)
        }
        for (const id of ids) {
          if (!live.has(id)) yield* enable(id)
        }
      }),
    rebindHost: (nextHost) =>
      Effect.gen(function* () {
        const previouslyEnabled = [...live.keys()]
        yield* disableAll()
        host = nextHost
        for (const id of previouslyEnabled) yield* enable(id).pipe(Effect.ignore)
        refreshStatus()
      }),
    disableAll,
  }
}
