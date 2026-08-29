import type { CallId, RequestId, SessionId, TurnId } from './ids'
import type { PublishedTool, ToolResult } from './tool'

/**
 * The trace is the product, not a by-product (design §1). Everything the system
 * does emits one of these, and the inspector, the export file, and the console
 * log are three renderings of the same data (R5.1).
 *
 * Plain discriminated unions rather than classes, so that export/import is
 * `JSON.stringify` / `JSON.parse` with no revival step (R5.5).
 */

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DetectionCandidate {
  readonly id: string
  readonly supported: boolean
  /** Why this candidate was rejected. The whole diagnosis lives here (R6.3). */
  readonly reason: string
}

export interface DetectionReport {
  readonly candidates: ReadonlyArray<DetectionCandidate>
  readonly selected: string
  readonly overridden: boolean
}

export type TracePayload =
  | { readonly kind: 'SessionStarted'; readonly userAgent: string }
  | { readonly kind: 'AdapterDetected'; readonly report: DetectionReport }
  | { readonly kind: 'AdapterSelected'; readonly adapterId: string; readonly specRevision: string }
  | { readonly kind: 'ToolSetEnabled'; readonly toolSetId: string; readonly tools: ReadonlyArray<string> }
  | { readonly kind: 'ToolSetDisabled'; readonly toolSetId: string }
  | { readonly kind: 'ToolRegistered'; readonly tool: string; readonly adapterId: string; readonly jsonSchema: unknown }
  | { readonly kind: 'ToolRegistrationFailed'; readonly tool: string; readonly adapterId: string; readonly hostMessage: string }
  | {
      readonly kind: 'ToolsListed'
      readonly tools: ReadonlyArray<string>
      /**
       * Whether the list came from the host itself or from our own mirror. The
       * superseded `provideContext` shape has no read-back, so an adapter for it
       * can only mirror — and pretending otherwise would hide exactly the kind
       * of fidelity gap this playground exists to show.
       */
      readonly source: 'host' | 'mirror'
    }
  | { readonly kind: 'ToolChanged'; readonly tools: ReadonlyArray<string> }
  | { readonly kind: 'TurnStarted'; readonly userMessage: string }
  | {
      readonly kind: 'ModelRequested'
      readonly driverId: string
      readonly model: string
      readonly strategy: 'native' | 'prompted'
      readonly step: number
      readonly messageCount: number
      /** Exactly what the model was offered, at this step (R5.3). */
      readonly tools: ReadonlyArray<PublishedTool>
      readonly request: unknown
    }
  | {
      readonly kind: 'ModelResponded'
      readonly text: string | null
      readonly reasoning?: string | null
      readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>
      /** Verbatim upstream JSON. A normalised-only view is what makes local-model debugging miserable. */
      readonly raw: unknown
    }
  | { readonly kind: 'ToolCallParseFailed'; readonly reason: string; readonly text: string }
  | { readonly kind: 'ToolCallStarted'; readonly tool: string; readonly input: unknown }
  | { readonly kind: 'ToolCallCompleted'; readonly tool: string; readonly result: ToolResult }
  | { readonly kind: 'ToolCallFailed'; readonly tool: string; readonly errorTag: string; readonly message: string }
  | { readonly kind: 'TurnCompleted'; readonly steps: number; readonly finalText: string | null }
  | { readonly kind: 'TurnFailed'; readonly errorTag: string; readonly message: string; readonly remedy?: string }
  | { readonly kind: 'TurnCancelled' }
  | { readonly kind: 'FaultInjected'; readonly tool: string; readonly fault: FaultKind }
  | { readonly kind: 'GeoRegionResolved'; readonly region: string; readonly coordinates: readonly [number, number]; readonly rule: string }
  | { readonly kind: 'GeoUpstreamFetched'; readonly sourceId: string; readonly url: string; readonly status: number; readonly cacheHit: boolean; readonly bytes: number }
  | { readonly kind: 'GeoGeometryProcessed'; readonly stage: 'clip' | 'simplify' | 'contour' | 'crossings'; readonly featuresIn: number; readonly verticesIn: number; readonly verticesOut: number; readonly durationMs: number }
  | { readonly kind: 'GeoRoutingFallbackTriggered'; readonly reason: string; readonly origin: readonly [number, number]; readonly destinationCount: number; readonly unavoided: boolean }
  | { readonly kind: 'GeoMapLayerUpdated'; readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
  | { readonly kind: 'LogRecord'; readonly level: TraceLevel; readonly message: string; readonly data?: unknown }
  | { readonly kind: 'Defect'; readonly message: string; readonly stack?: string }
  | { readonly kind: 'EventsDiscarded'; readonly count: number }

export type TraceEventKind = TracePayload['kind']

export interface TraceCorrelation {
  readonly turnId?: TurnId
  readonly callId?: CallId
  readonly requestId?: RequestId
  readonly durationMs?: number
  readonly spanName?: string
}

export interface TraceEvent extends TraceCorrelation {
  readonly seq: number
  readonly at: number
  readonly sessionId: SessionId
  readonly payload: TracePayload
}

export type FaultKind = 'fail' | 'hang' | 'invalid'

/** What a trace export file contains. Self-contained by design (R5.5). */
export interface TraceExport {
  readonly formatVersion: 1
  readonly sessionId: SessionId
  readonly exportedAt: number
  readonly adapterId: string
  readonly specRevision: string
  readonly driverId: string
  readonly model: string | null
  readonly toolSets: ReadonlyArray<string>
  readonly events: ReadonlyArray<TraceEvent>
  readonly discarded: number
}

/** Severity for display. Kept beside the payload union so a new kind must be classified. */
export const levelOf = (payload: TracePayload): TraceLevel => {
  switch (payload.kind) {
    case 'Defect':
    case 'TurnFailed':
    case 'ToolRegistrationFailed':
      return 'error'
    case 'ToolCallFailed':
    case 'ToolCallParseFailed':
    case 'FaultInjected':
    case 'EventsDiscarded':
    case 'TurnCancelled':
    case 'GeoRoutingFallbackTriggered':
      return 'warn'
    case 'LogRecord':
      return payload.level
    default:
      return 'info'
  }
}

/** Coarse grouping used by the inspector's filter chips (R5.2). */
export type TraceCategory = 'session' | 'adapter' | 'tools' | 'model' | 'turn' | 'geo' | 'log' | 'error'

export const categoryOf = (payload: TracePayload): TraceCategory => {
  switch (payload.kind) {
    case 'SessionStarted':
    case 'EventsDiscarded':
      return 'session'
    case 'AdapterDetected':
    case 'AdapterSelected':
      return 'adapter'
    case 'ToolSetEnabled':
    case 'ToolSetDisabled':
    case 'ToolRegistered':
    case 'ToolsListed':
    case 'ToolChanged':
    case 'ToolCallStarted':
    case 'ToolCallCompleted':
    case 'FaultInjected':
      return 'tools'
    case 'GeoRegionResolved':
    case 'GeoUpstreamFetched':
    case 'GeoGeometryProcessed':
    case 'GeoRoutingFallbackTriggered':
    case 'GeoMapLayerUpdated':
      return 'geo'
    case 'ModelRequested':
    case 'ModelResponded':
    case 'ToolCallParseFailed':
      return 'model'
    case 'TurnStarted':
    case 'TurnCompleted':
    case 'TurnCancelled':
      return 'turn'
    case 'LogRecord':
      return 'log'
    case 'ToolRegistrationFailed':
    case 'ToolCallFailed':
    case 'TurnFailed':
    case 'Defect':
      return 'error'
  }
}

export const summarise = (event: TraceEvent): string => {
  const p = event.payload
  switch (p.kind) {
    case 'SessionStarted':
      return 'session started'
    case 'AdapterDetected':
      return `detected ${p.report.candidates.filter((c) => c.supported).length}/${p.report.candidates.length} adapters`
    case 'AdapterSelected':
      return `${p.adapterId} (${p.specRevision})`
    case 'ToolSetEnabled':
      return `${p.toolSetId}: ${p.tools.length} tools`
    case 'ToolSetDisabled':
      return p.toolSetId
    case 'ToolRegistered':
      return p.tool
    case 'ToolRegistrationFailed':
      return `${p.tool} — ${p.hostMessage}`
    case 'ToolsListed':
      return `${p.tools.length} tools from ${p.source}`
    case 'ToolChanged':
      return `now ${p.tools.length} tools`
    case 'TurnStarted':
      return p.userMessage.slice(0, 80)
    case 'ModelRequested':
      return `step ${p.step} → ${p.model} (${p.strategy}, ${p.tools.length} tools)`
    case 'ModelResponded': {
      const thought = p.reasoning === null || p.reasoning === undefined ? '' : ' · thought first'
      return p.toolCalls.length > 0
        ? `${p.toolCalls.length} tool call(s): ${p.toolCalls.map((c) => c.name).join(', ')}${thought}`
        : `${(p.text ?? '').slice(0, 80)}${thought}`
    }
    case 'ToolCallParseFailed':
      return p.reason
    case 'ToolCallStarted':
      return p.tool
    case 'ToolCallCompleted':
      return `${p.tool} → ${p.result.isError ? 'isError' : 'ok'}`
    case 'ToolCallFailed':
      return `${p.tool} — ${p.errorTag}`
    case 'TurnCompleted':
      return `${p.steps} step(s)`
    case 'TurnFailed':
      return `${p.errorTag}: ${p.message}`
    case 'TurnCancelled':
      return 'cancelled by user'
    case 'FaultInjected':
      return `${p.fault} on ${p.tool}`
    case 'GeoRegionResolved':
      return `resolved region ${p.region.toUpperCase()} (${p.rule})`
    case 'GeoUpstreamFetched':
      return `${p.sourceId} → HTTP ${p.status} (${p.bytes} B, cache: ${p.cacheHit ? 'hit' : 'miss'})`
    case 'GeoGeometryProcessed':
      return `${p.stage}: ${p.featuresIn} in → ${p.verticesOut} vertices (${p.durationMs}ms)`
    case 'GeoRoutingFallbackTriggered':
      return `routing fallback: ${p.reason} (unavoided: ${p.unavoided})`
    case 'GeoMapLayerUpdated':
      return `layer '${p.layerId}' updated (${p.featureCount} features, ${p.vertexCount} vertices)`
    case 'LogRecord':
      return p.message
    case 'Defect':
      return p.message
    case 'EventsDiscarded':
      return `${p.count} older events discarded`
  }
}
