/**
 * Provenance, coverage, and staleness domain models (R2.3, R2.9, R7.3, R8.1).
 */

export type DataMode = 'live' | 'fixture'

export interface Provenance {
  readonly sourceId: string // e.g. 'jp.gsi.flood-l2', 'us.nws.alerts'
  readonly sourceName: string // shown to human, verbatim from authority
  readonly upstreamUrl: string // key-redacted, exact call
  readonly datasetVintage?: string // for scenario data with no issuance time
  readonly issuedAt?: number // epoch ms
  readonly retrievedAt: number // epoch ms
  readonly cache: { readonly hit: boolean; readonly ageMs: number }
  readonly licence: string
  readonly attribution: string // rendered wherever data is shown (R8.10)
  readonly mode: DataMode // 'fixture' forces SIMULATED marker (R8.4)
}

/** Why a result is less than the whole truth. Never silently empty (R2.8). */
export interface Coverage {
  readonly state: 'full' | 'partial' | 'none'
  readonly reason?: 'tile_cap' | 'no_data_for_area' | 'source_failed' | 'result_cap'
  readonly detail?: string // e.g. "48 of 96 tiles analysed (NE quadrant missing)"
  readonly failedSources: ReadonlyArray<{ readonly sourceId: string; readonly error: string }>
}

export interface Staleness {
  readonly stale: boolean
  readonly ageMs?: number
  readonly expectedRefreshMs?: number
}

/**
 * Calculates staleness against expectedRefreshMs (R2.9).
 */
export const calculateStaleness = (
  issuedAt: number | undefined,
  nowOrRetrievedAt: number,
  expectedRefreshMs: number | undefined,
): Staleness => {
  if (issuedAt === undefined || expectedRefreshMs === undefined) {
    return { stale: false }
  }
  const ageMs = Math.max(0, nowOrRetrievedAt - issuedAt)
  const stale = ageMs > expectedRefreshMs
  return {
    stale,
    ageMs,
    expectedRefreshMs,
  }
}
