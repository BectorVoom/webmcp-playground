import type { AdapterId, SpecRevision, ToolHostService } from '../../ports/ToolHost'
import type { ToolRunner } from '../../ports/ToolRunner'
import type { TraceSinkService } from '../../ports/TraceSink'
import { makeDraftHost } from './draft-2026-04'
import { makeInMemoryHost } from './in-memory'
import { makeLegacyHost } from './legacy-navigator'
import './spec-types'

/**
 * The adapter catalogue. Supporting a new WebMCP revision means adding one
 * module and one entry here — nothing in domain/, ports/, app/ or ui/ moves
 * (R6.6, R6.7). That property is the entire return on the ports-and-adapters
 * investment, so keep this file boring.
 *
 * Order is precedence: the first supported entry wins when no override is set.
 */

export interface AdapterProbe {
  readonly supported: boolean
  /** Why not, in terms a reader can act on. "No WebMCP" and "WebMCP without registerTool" are different diagnoses. */
  readonly reason: string
}

export interface AdapterEntry {
  readonly id: AdapterId
  readonly specRevision: SpecRevision
  readonly probe: () => AdapterProbe
  readonly make: (runner: ToolRunner, sink: TraceSinkService) => ToolHostService
}

const probeDraft = (): AdapterProbe => {
  if (typeof document === 'undefined') {
    return { supported: false, reason: 'no document (non-browser environment)' }
  }
  const modelContext = document.modelContext
  if (modelContext === undefined) {
    return { supported: false, reason: 'document.modelContext is not implemented by this browser' }
  }
  if (typeof modelContext.registerTool !== 'function') {
    return {
      supported: false,
      reason: 'document.modelContext exists but has no registerTool — the draft has probably moved',
    }
  }
  if (typeof modelContext.getTools !== 'function') {
    return {
      supported: false,
      reason: 'document.modelContext.registerTool exists but getTools does not; read-back would be impossible',
    }
  }
  return { supported: true, reason: 'document.modelContext.registerTool and getTools are present' }
}

const probeLegacy = (): AdapterProbe => {
  if (typeof navigator === 'undefined') {
    return { supported: false, reason: 'no navigator (non-browser environment)' }
  }
  const modelContext = navigator.modelContext
  if (modelContext === undefined) {
    return { supported: false, reason: 'navigator.modelContext is not implemented by this browser' }
  }
  if (typeof modelContext.provideContext !== 'function') {
    return {
      supported: false,
      reason: 'navigator.modelContext exists but has no provideContext',
    }
  }
  return { supported: true, reason: 'navigator.modelContext.provideContext is present' }
}

export const ADAPTERS: ReadonlyArray<AdapterEntry> = [
  {
    id: 'draft-2026-04',
    specRevision: {
      label: 'W3C CG Draft Report, 2026-08-26 (Origin Trial compatible)',
      url: 'https://webmachinelearning.github.io/webmcp/',
    },
    probe: probeDraft,
    make: (runner, sink) => {
      const modelContext = document.modelContext
      return modelContext === undefined
        ? makeInMemoryHost(runner, sink)
        : makeDraftHost(modelContext, runner, sink)
    },
  },
  {
    id: 'legacy-navigator',
    specRevision: {
      label: 'superseded navigator.modelContext.provideContext',
      url: 'https://github.com/webmachinelearning/webmcp',
    },
    probe: probeLegacy,
    make: (runner, sink) => {
      const modelContext = navigator.modelContext
      return modelContext === undefined
        ? makeInMemoryHost(runner, sink)
        : makeLegacyHost(modelContext, runner, sink)
    },
  },
  {
    id: 'in-memory',
    specRevision: {
      label: 'in-memory reference host',
      url: 'https://webmachinelearning.github.io/webmcp/',
    },
    // Always available by design: the app must be exercisable where WebMCP is not.
    probe: () => ({ supported: true, reason: 'always available' }),
    make: (runner, sink) => makeInMemoryHost(runner, sink),
  },
]

export const findAdapter = (id: AdapterId): AdapterEntry | undefined =>
  ADAPTERS.find((entry) => entry.id === id)
