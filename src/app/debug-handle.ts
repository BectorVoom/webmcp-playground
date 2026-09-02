import { Effect } from 'effect'
import type { Turn } from '../domain/chat'
import type { HostTool, ToolResult } from '../domain/tool'
import type { TraceEvent, TraceExport, TraceLevel } from '../domain/trace'
import type { AdapterId } from '../ports/ToolHost'
import type { DriverId } from '../ports/LlmClient'
import type { MapLayerData } from '../ports/Map'
import type { RenderedLayerReport } from '../adapters/map/maplibre'
import type { FaultSpec } from './fault-injector'
import type { Session } from './session'
import { getConsoleLogLevel, setConsoleLogLevel } from './logger'
import { SCENARIOS } from '../adapters/llm/scripted'
import {
  currentDataMode,
  currentMapPort,
  setDisasterGeolocationPort,
} from '../toolsets/disaster'
import { BrowserGeolocationAdapter } from '../adapters/geo/browser-geolocation'
import { MapLibreAdapter } from '../adapters/map/maplibre'

export interface GeoDebugStats {
  readonly dataMode: 'live' | 'fixture'
  readonly activeLayersCount: number
  readonly pinnedPosition?: { latitude: number; longitude: number }
}

export interface WebMcpDebugHandle {
  readonly sessionId: string
  getTrace(filter?: { kinds?: ReadonlyArray<string>; turnId?: string }): ReadonlyArray<TraceEvent>
  getTools(): Promise<ReadonlyArray<HostTool>>
  getAdapter(): {
    id: AdapterId
    specRevision: string
    detection: ReturnType<Session['state']['snapshot']>['detection']
  }
  callTool(name: string, input: unknown): Promise<ToolResult>
  setToolSets(ids: ReadonlyArray<string>): Promise<void>
  setAdapter(id: AdapterId | undefined): Promise<void>
  setDriver(id: DriverId): Promise<void>
  setModel(model: string): Promise<void>
  setStrategy(strategy: 'native' | 'prompted'): void
  setLogLevel(level: TraceLevel): void
  sendMessage(text: string): Promise<Turn>
  injectFault(spec: FaultSpec): void
  waitForIdle(timeoutMs?: number): Promise<void>
  exportTrace(): TraceExport
  importTrace(value: unknown): boolean
  saveTrace(): Promise<{ path: string; bytes: number }>
  getState(): ReturnType<Session['state']['snapshot']>
  getGeoStats(): GeoDebugStats
  getActiveLayers(): Promise<ReadonlyArray<MapLayerData>>
  getMapRendering(): ReadonlyArray<RenderedLayerReport> | null
  simulateDisasterScenario(name?: string): Promise<Turn>
  reset(): Promise<void>
  help(): string
}

const HELP = `window.__WEBMCP_DEBUG__ — drive and inspect this page without the UI.

  await d.sendMessage("add milk")     run a full turn
  await d.waitForIdle()               resolve when the turn settles
  d.getTrace({ turnId: "turn_1" })    the ordered, typed account of what happened
  await d.callTool("todo.add", { text: "milk" })
                                      invoke a tool with the model bypassed —
                                      separates "tool is broken" from
                                      "model called it wrong"
  await d.getTools()                  what the host actually holds
  d.getAdapter()                      active adapter, spec revision, why
  d.injectFault({ kind: "fail", count: 1 })
  await d.setToolSets(["todo"])       change what is registered
  await d.setDriver("scripted")       deterministic, needs no LLM
  await d.saveTrace()                 writes .traces/<sessionId>.json, returns the path
  d.importTrace(json)                 reconstruct a transcript from an export
  d.getGeoStats()                     dataMode, active layers count
  await d.getActiveLayers()           all current map layers and features
  d.getMapRendering()                 per layer: source, sublayers, visibility and the
                                      feature count MapLibre actually drew — the first
                                      thing to check when the map looks empty
  await d.simulateDisasterScenario()  pins position to Tokyo and runs full flow
  await d.reset()

Scripted driver scenarios (keyword → behaviour):
${SCENARIOS.map((s) => `  ${s.keywords[0]} — ${s.description}`).join('\n')}
`

export const createDebugHandle = (session: Session): WebMcpDebugHandle => ({
  sessionId: session.sessionId,

  getTrace: (filter) => {
    const events = session.traceStore.snapshot()
    if (filter === undefined) return events
    return events.filter(
      (event) =>
        (filter.kinds === undefined || filter.kinds.includes(event.payload.kind)) &&
        (filter.turnId === undefined || event.turnId === filter.turnId),
    )
  },

  getTools: () =>
    session.runtime.runPromise(Effect.orElseSucceed(session.host().listTools(), () => [])),

  getAdapter: () => {
    const state = session.state.snapshot()
    return {
      id: state.adapterId,
      specRevision: state.specRevision.label,
      detection: state.detection,
    }
  },

  callTool: (name, input) =>
    session.runtime.runPromise(
      session
        .host()
        .execute(name, input, { signal: new AbortController().signal })
        .pipe(Effect.catchAll((error) => Effect.die(error))),
    ),

  setToolSets: (ids) => session.setToolSets(ids),
  setAdapter: (id) => session.setAdapter(id),
  setDriver: (id) => session.setDriver(id),
  setModel: (model) => session.setModel(model),
  setStrategy: (strategy) => session.setStrategy(strategy),

  setLogLevel: (level) => {
    setConsoleLogLevel(level)
    session.setLogLevel(level)
  },

  sendMessage: (text) => session.sendMessage(text),
  injectFault: (spec) => session.injectFault(spec),

  getGeoStats: () => {
    return {
      dataMode: currentDataMode,
      activeLayersCount: 0,
    }
  },

  // Only a real MapLibre map can say what it drew; the in-memory port used in tests and in the
  // no-WebGL list view has no canvas to ask, and says so rather than inventing zeroes.
  getMapRendering: () =>
    currentMapPort instanceof MapLibreAdapter ? currentMapPort.inspectRendering() : null,

  getActiveLayers: () => session.runtime.runPromise(currentMapPort.readAllLayers()),

  simulateDisasterScenario: async () => {
    const geoAdapter = new BrowserGeolocationAdapter()
    geoAdapter.setPinnedPosition({
      coordinates: { latitude: 35.6812, longitude: 139.7671 },
      accuracyMetres: 20,
      source: 'pinned',
      resolvedAt: Date.now(),
    })
    setDisasterGeolocationPort(geoAdapter)
    await session.setToolSets(['disaster'])
    return session.sendMessage('disaster flood in tokyo')
  },

  waitForIdle: (timeoutMs = 30_000) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        if (session.state.snapshot().status === 'idle') {
          resolve()
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`waitForIdle timed out after ${timeoutMs} ms`))
          return
        }
        setTimeout(tick, 25)
      }
      tick()
    }),

  exportTrace: () => session.exportTrace(),
  importTrace: (value) => session.importTrace(value),
  saveTrace: () => session.saveTrace(),
  getState: () => session.state.snapshot(),
  reset: () => session.reset(),
  help: () => HELP,
})

declare global {
  interface Window {
    __WEBMCP_DEBUG__?: WebMcpDebugHandle
  }
}

export const installDebugHandle = (session: Session): WebMcpDebugHandle => {
  const handle = createDebugHandle(session)
  if (typeof window !== 'undefined') {
    window.__WEBMCP_DEBUG__ = handle
    console.info(
      `[webmcp] debug handle ready — window.__WEBMCP_DEBUG__.help()  ·  log level ${getConsoleLogLevel()}`,
    )
  }
  return handle
}
