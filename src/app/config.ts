import type { AdapterId } from '../ports/ToolHost'
import type { DriverId, ToolCallStrategy } from '../ports/LlmClient'
import type { TraceLevel } from '../domain/trace'

/**
 * Client configuration lives in the URL (R2.8). That is not a stylistic choice:
 * it means a coding agent can hand a human — or another agent — a link that
 * reproduces the exact configuration a bug appeared under, which is otherwise
 * a paragraph of instructions nobody follows precisely.
 */

export interface ClientConfig {
  readonly toolSets: ReadonlyArray<string>
  /** Undefined means "use capability detection"; a value forces an adapter (R6.4). */
  readonly adapter: AdapterId | undefined
  readonly driver: DriverId | undefined
  readonly model: string | undefined
  readonly strategy: ToolCallStrategy
  readonly maxSteps: number
  readonly toolTimeoutMs: number
  readonly logLevel: TraceLevel
}

export const DEFAULT_CONFIG: ClientConfig = {
  // The product opens with its competition surface, not the harness tools. Todo, forms,
  // diagnostics, and page control remain selectable for adapter development and regression work.
  toolSets: ['disaster'],
  adapter: undefined,
  driver: undefined,
  model: undefined,
  strategy: 'native',
  maxSteps: 8,
  toolTimeoutMs: 30_000,
  logLevel: 'info',
}

const ADAPTERS: ReadonlyArray<AdapterId> = ['draft-2026-04', 'legacy-navigator', 'in-memory']
const DRIVERS: ReadonlyArray<DriverId> = ['local', 'scripted']
const STRATEGIES: ReadonlyArray<ToolCallStrategy> = ['native', 'prompted']
const LEVELS: ReadonlyArray<TraceLevel> = ['debug', 'info', 'warn', 'error']

const oneOf = <T extends string>(allowed: ReadonlyArray<T>, raw: string | null): T | undefined =>
  raw !== null && (allowed as ReadonlyArray<string>).includes(raw) ? (raw as T) : undefined

const positiveInt = (raw: string | null, fallback: number): number => {
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const parseConfig = (search: string): ClientConfig => {
  const params = new URLSearchParams(search)
  const toolSetsRaw = params.get('toolSets')
  return {
    toolSets:
      toolSetsRaw === null
        ? DEFAULT_CONFIG.toolSets
        : toolSetsRaw.split(',').map((s) => s.trim()).filter(Boolean),
    adapter: oneOf(ADAPTERS, params.get('adapter')),
    driver: oneOf(DRIVERS, params.get('driver')),
    model: params.get('model') ?? undefined,
    strategy: oneOf(STRATEGIES, params.get('strategy')) ?? DEFAULT_CONFIG.strategy,
    maxSteps: positiveInt(params.get('maxSteps'), DEFAULT_CONFIG.maxSteps),
    toolTimeoutMs: positiveInt(params.get('toolTimeoutMs'), DEFAULT_CONFIG.toolTimeoutMs),
    logLevel: oneOf(LEVELS, params.get('logLevel')) ?? DEFAULT_CONFIG.logLevel,
  }
}

/** Only non-default values are written, so a shared URL stays readable. */
export const toSearch = (config: ClientConfig): string => {
  const params = new URLSearchParams()
  const sameToolSets =
    config.toolSets.length === DEFAULT_CONFIG.toolSets.length &&
    config.toolSets.every((id, i) => id === DEFAULT_CONFIG.toolSets[i])
  if (!sameToolSets) params.set('toolSets', config.toolSets.join(','))
  if (config.adapter !== undefined) params.set('adapter', config.adapter)
  if (config.driver !== undefined) params.set('driver', config.driver)
  if (config.model !== undefined) params.set('model', config.model)
  if (config.strategy !== DEFAULT_CONFIG.strategy) params.set('strategy', config.strategy)
  if (config.maxSteps !== DEFAULT_CONFIG.maxSteps) params.set('maxSteps', String(config.maxSteps))
  if (config.toolTimeoutMs !== DEFAULT_CONFIG.toolTimeoutMs)
    params.set('toolTimeoutMs', String(config.toolTimeoutMs))
  if (config.logLevel !== DEFAULT_CONFIG.logLevel) params.set('logLevel', config.logLevel)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}
