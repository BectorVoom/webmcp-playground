import { Effect, Fiber, Stream } from 'effect'
import { detectAdapter } from '../adapters/webmcp/detect'
import { findAdapter } from '../adapters/webmcp/registry'
import { makeLocalClient } from '../adapters/llm/local'
import { makeScriptedClient } from '../adapters/llm/scripted'
import { createTraceStore } from '../adapters/trace/memory-store'
import { makeMemorySink } from '../adapters/trace/memory-sink'
import type { ChatMessage, Turn } from '../domain/chat'
import { createIdFactory, newSessionId, type TurnId } from '../domain/ids'
import type { DetectionReport, TraceExport, TraceLevel } from '../domain/trace'
import { isTraceExport, reconstructTurns } from '../domain/trace-replay'
import type { HealthResponse, TraceWriteResponse } from '../domain/wire'
import type { AdapterId, SpecRevision, ToolHostService } from '../ports/ToolHost'
import type { DriverId, LlmClientService, ModelInfo, ToolCallStrategy } from '../ports/LlmClient'
import { TOOL_SETS, resetTodos } from '../toolsets'
import { createStore } from '../lib/store'
import { runTurn } from './agent-loop'
import { DEFAULT_CONFIG, parseConfig, toSearch, type ClientConfig } from './config'
import { createFaultInjector, type FaultSpec } from './fault-injector'
import { setConsoleLogLevel } from './logger'
import { createAppRuntime } from './runtime'
import { createToolRegistryManager } from './tool-registry'
import { createToolRunner } from './tool-runner'

/**
 * The composition root, and the only stateful singleton in the app.
 *
 * Everything mutable lives here — the trace, the host, the driver, the
 * transcript — so there is exactly one place to look when the question is "what
 * is this page's current state?", and exactly one object for the debug handle
 * to expose (R5.9).
 */

export interface SessionState {
  readonly turns: ReadonlyArray<Turn>
  readonly status: 'idle' | 'running'
  readonly adapterId: AdapterId
  readonly specRevision: SpecRevision
  readonly detection: DetectionReport
  readonly driverId: DriverId
  readonly model: string
  readonly models: ReadonlyArray<ModelInfo>
  readonly health: HealthResponse | null
  /** A plain-language explanation when the app chose something for the user (R4.4). */
  readonly notice: string | null
  readonly config: ClientConfig
  /** An imported trace is a read-only reconstruction, and says so (R5.5). */
  readonly imported: boolean
}

const SCRIPTED_MODEL = 'scripted'

export const createSession = () => {
  const sessionId = newSessionId()
  const ids = createIdFactory()
  const traceStore = createTraceStore(sessionId)
  const sink = makeMemorySink(traceStore)
  const runtime = createAppRuntime(traceStore)
  const faults = createFaultInjector()

  let config: ClientConfig =
    typeof location === 'undefined' ? DEFAULT_CONFIG : parseConfig(location.search)
  setConsoleLogLevel(config.logLevel)

  const runner = createToolRunner({
    sink,
    faults,
    ids,
    timeoutMs: () => config.toolTimeoutMs,
    currentTurnId: () => currentTurnId,
  })

  const detected = detectAdapter(config.adapter)
  let host: ToolHostService = detected.entry.make(runner, sink)
  let client: LlmClientService = makeScriptedClient()
  let currentTurnId: TurnId | undefined
  let controller: AbortController | undefined
  let conversation: ReadonlyArray<ChatMessage> = []
  let stopObservingHostChanges: (() => void) | undefined

  const manager = createToolRegistryManager(TOOL_SETS, host, sink)

  const state = createStore<SessionState>({
    turns: [],
    status: 'idle',
    adapterId: detected.entry.id,
    specRevision: detected.entry.specRevision,
    detection: detected.report,
    driverId: 'scripted',
    model: SCRIPTED_MODEL,
    models: [],
    health: null,
    notice: null,
    config,
    imported: false,
  })

  const syncUrl = () => {
    if (typeof history === 'undefined' || typeof location === 'undefined') return
    history.replaceState(null, '', `${location.pathname}${toSearch(config)}`)
  }

  const setConfig = (patch: Partial<ClientConfig>) => {
    config = { ...config, ...patch }
    state.update((s) => ({ ...s, config }))
    syncUrl()
  }

  const run = <A>(effect: Effect.Effect<A, never>) => runtime.runPromise(effect)

  const observeHostChanges = (target: ToolHostService): void => {
    stopObservingHostChanges?.()
    const fiber = runtime.runFork(
      Stream.runForEach(target.changes, () =>
        Effect.flatMap(Effect.orElseSucceed(target.listTools(), () => []), (tools) =>
          sink.emit({ kind: 'ToolChanged', tools: tools.map((tool) => tool.name) }),
        ),
      ),
    )
    stopObservingHostChanges = () => {
      void run(Fiber.interrupt(fiber))
    }
  }

  /**
   * Driver selection (R4.4). Choosing `local` when nothing is listening would
   * fail the user's first message with a network error; probing first means the
   * app can say what it did and why, before anything breaks.
   */
  const chooseDriver = async (): Promise<void> => {
    let health: HealthResponse | null = null
    try {
      const response = await fetch('/api/health')
      health = (await response.json()) as HealthResponse
    } catch {
      health = null
    }

    const wanted = config.driver
    const reachable = health?.upstream.reachable === true && health.upstream.modelCount > 0

    if (wanted === 'scripted' || (wanted === undefined && !reachable)) {
      client = makeScriptedClient()
      state.update((s) => ({
        ...s,
        health,
        driverId: 'scripted',
        model: SCRIPTED_MODEL,
        notice:
          wanted === 'scripted'
            ? null
            : health === null
              ? 'The backend is not responding, so the scripted driver is in use. Chat still works; no model is being called.'
              : `No local model was reachable at ${health.upstream.baseUrl}, so the scripted driver is in use. ${health.upstream.remedy ?? ''}`.trim(),
      }))
      return
    }

    const models = await run(
      Effect.orElseSucceed(makeLocalClient('').listModels(), () => [] as ReadonlyArray<ModelInfo>),
    )
    const model = config.model ?? health?.defaultModel ?? models[0]?.id ?? ''

    if (model === '') {
      client = makeScriptedClient()
      state.update((s) => ({
        ...s,
        health,
        models,
        driverId: 'scripted',
        model: SCRIPTED_MODEL,
        notice: 'The endpoint is reachable but reports no models, so the scripted driver is in use.',
      }))
      return
    }

    client = makeLocalClient(model)
    state.update((s) => ({
      ...s,
      health,
      models,
      driverId: 'local',
      model,
      notice: null,
    }))
  }

  const start = async (): Promise<void> => {
    await run(
      sink.emit({
        kind: 'SessionStarted',
        userAgent: typeof navigator === 'undefined' ? 'non-browser' : navigator.userAgent,
      }),
    )
    await run(sink.emit({ kind: 'AdapterDetected', report: detected.report }))
    await run(
      sink.emit({
        kind: 'AdapterSelected',
        adapterId: detected.entry.id,
        specRevision: detected.entry.specRevision.label,
      }),
    )
    observeHostChanges(host)
    // `runFork` schedules stream acquisition. Yield once so the listener is
    // attached before registry registration emits its first host change.
    await run(Effect.yieldNow())
    await run(Effect.ignore(manager.setEnabled(config.toolSets)))
    await chooseDriver()
  }

  const appendTurn = (turn: Turn) => {
    state.update((s) => ({ ...s, turns: [...s.turns, turn], status: 'idle' }))
  }

  const executeTurn = async (userMessage: string): Promise<Turn> => {
    if (state.snapshot().status === 'running') {
      return Promise.reject(new Error('A turn is already running'))
    }
    const turnId = ids.newTurnId()
    currentTurnId = turnId
    controller = new AbortController()
    state.update((s) => ({ ...s, status: 'running' }))

    const turn = await run(
      runTurn(turnId, conversation, userMessage, {
        host,
        client,
        sink,
        ids,
        model: state.snapshot().model,
        strategy: config.strategy,
        maxSteps: config.maxSteps,
        signal: controller.signal,
      }),
    )

    conversation =
      turn.finalText === null
        ? turn.messages
        : [...turn.messages, { role: 'assistant', content: turn.finalText, toolCalls: [] }]

    currentTurnId = undefined
    controller = undefined
    appendTurn(turn)
    return turn
  }

  const exportTraceValue = (): TraceExport => {
    const snapshot = state.snapshot()
    return {
      formatVersion: 1,
      sessionId,
      exportedAt: Date.now(),
      adapterId: snapshot.adapterId,
      specRevision: snapshot.specRevision.label,
      driverId: snapshot.driverId,
      model: snapshot.model,
      toolSets: config.toolSets,
      events: traceStore.snapshot(),
      discarded: traceStore.discardedCount(),
    }
  }

  const rebuildHost = async (adapterId: AdapterId | undefined): Promise<void> => {
    const next = detectAdapter(adapterId)
    host = next.entry.make(runner, sink)
    observeHostChanges(host)
    await run(Effect.yieldNow())
    await run(Effect.ignore(manager.rebindHost(host)))
    await run(
      sink.emit({
        kind: 'AdapterSelected',
        adapterId: next.entry.id,
        specRevision: next.entry.specRevision.label,
      }),
    )
    state.update((s) => ({
      ...s,
      adapterId: next.entry.id,
      specRevision: next.entry.specRevision,
      detection: next.report,
    }))
  }

  return {
    sessionId,
    traceStore,
    sink,
    runtime,
    faults,
    manager,
    state,
    start,

    host: () => host,
    client: () => client,
    config: () => config,

    sendMessage: executeTurn,

    cancel: (): void => controller?.abort(),

    retryTurn: async (turnId: TurnId): Promise<Turn | undefined> => {
      const turns = state.snapshot().turns
      const index = turns.findIndex((t) => t.id === turnId)
      if (index === -1) return undefined
      const target = turns[index]!
      // Rewind the conversation to just before the turn being retried, so the
      // retry sees the same history the original did.
      conversation = turns.slice(0, index).flatMap((t) =>
        t.finalText === null
          ? t.messages
          : [...t.messages, { role: 'assistant' as const, content: t.finalText, toolCalls: [] }],
      )
      state.update((s) => ({ ...s, turns: turns.slice(0, index) }))
      return executeTurn(target.userMessage)
    },

    setToolSets: async (ids: ReadonlyArray<string>): Promise<void> => {
      setConfig({ toolSets: ids })
      await run(Effect.ignore(manager.setEnabled(ids)))
    },

    setAdapter: async (adapterId: AdapterId | undefined): Promise<void> => {
      setConfig({ adapter: adapterId })
      await rebuildHost(adapterId)
    },

    setDriver: async (driverId: DriverId): Promise<void> => {
      setConfig({ driver: driverId })
      await chooseDriver()
    },

    setModel: async (model: string): Promise<void> => {
      setConfig({ model })
      await chooseDriver()
    },

    setStrategy: (strategy: ToolCallStrategy): void => setConfig({ strategy }),
    setMaxSteps: (maxSteps: number): void => setConfig({ maxSteps }),
    setToolTimeout: (toolTimeoutMs: number): void => setConfig({ toolTimeoutMs }),
    setLogLevel: (logLevel: TraceLevel): void => {
      setConsoleLogLevel(logLevel)
      setConfig({ logLevel })
    },

    injectFault: (spec: FaultSpec): void => faults.arm(spec),

    exportTrace: exportTraceValue,

    importTrace: (value: unknown): boolean => {
      if (!isTraceExport(value)) return false
      controller?.abort()
      traceStore.replace(value.events, value.discarded)
      conversation = []
      state.update((s) => ({
        ...s,
        turns: reconstructTurns(value.events),
        status: 'idle',
        imported: true,
        notice: `Viewing an imported trace from session ${value.sessionId} (adapter ${value.adapterId}, driver ${value.driverId}). This view is read-only; reset to start a live session.`,
      }))
      return true
    },

    saveTrace: async (): Promise<TraceWriteResponse> => {
      const response = await fetch('/api/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, trace: exportTraceValue() }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        return Promise.reject(
          new Error(`Could not write the trace: ${body.error ?? response.status}`),
        )
      }
      return (await response.json()) as TraceWriteResponse
    },

    reset: async (): Promise<void> => {
      controller?.abort()
      await run(Effect.ignore(manager.disableAll()))
      traceStore.clear()
      ids.reset()
      resetTodos()
      conversation = []
      state.update((s) => ({ ...s, turns: [], status: 'idle', imported: false, notice: null }))
      await run(Effect.ignore(manager.setEnabled(config.toolSets)))
    },

    availableAdapters: () => detected.report.candidates.map((c) => ({ ...c, entry: findAdapter(c.id as AdapterId) })),
  }
}

export type Session = ReturnType<typeof createSession>
