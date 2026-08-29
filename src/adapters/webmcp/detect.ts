import type { AdapterId } from '../../ports/ToolHost'
import type { DetectionReport } from '../../domain/trace'
import { ADAPTERS, findAdapter, type AdapterEntry } from './registry'

/**
 * Capability detection (R6.3).
 *
 * The report records why each candidate was rejected, not merely which one won.
 * "No WebMCP in this browser" and "WebMCP present but registerTool is gone"
 * lead to completely different actions, and a detector that reports only the
 * winner throws that distinction away.
 */
export interface DetectionResult {
  readonly entry: AdapterEntry
  readonly report: DetectionReport
}

export const detectAdapter = (override?: AdapterId): DetectionResult => {
  const candidates = ADAPTERS.map((entry) => {
    const probe = entry.probe()
    return { id: entry.id, supported: probe.supported, reason: probe.reason }
  })

  const forced = override === undefined ? undefined : findAdapter(override)
  const selected =
    forced ?? ADAPTERS.find((entry) => entry.probe().supported) ?? ADAPTERS[ADAPTERS.length - 1]!

  return {
    entry: selected,
    report: {
      candidates,
      selected: selected.id,
      overridden: forced !== undefined,
    },
  }
}
