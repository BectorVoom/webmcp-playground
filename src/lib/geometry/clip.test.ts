import { describe, expect, it } from 'vitest'
import { clipAndMergeZones } from './clip'
import type { FloodZone } from '../../domain/hazard'
import type { Provenance } from '../../domain/provenance'

const FUKUI = { latitude: 36.0621, longitude: 136.2222 }

const provenanceOf = (sourceId: string): Provenance => ({
  sourceId,
  sourceName: sourceId,
  upstreamUrl: 'https://example.test',
  retrievedAt: 1_756_512_000_000,
  cache: { hit: false, ageMs: 0 },
  licence: 'test',
  attribution: sourceId,
  mode: 'live',
})

/** Two overlapping squares over Fukui, so any merge that is going to happen will happen. */
const squareAt = (offset: number): Array<Array<[number, number]>> => [
  [
    [136.20 + offset, 36.04],
    [136.24 + offset, 36.04],
    [136.24 + offset, 36.08],
    [136.20 + offset, 36.08],
    [136.20 + offset, 36.04],
  ],
]

const zone = (over: Partial<FloodZone> & { sourceId: string; offset?: number }): FloodZone => ({
  id: `${over.sourceId}-zone`,
  kind: { kind: 'scenario', designEvent: 'L2 assumed maximum' },
  hazardClass: 'high',
  geometry: { type: 'Polygon', coordinates: squareAt(over.offset ?? 0) },
  provenance: provenanceOf(over.sourceId),
  ...over,
})

describe('clipAndMergeZones', () => {
  it('merges two zones of the same class from the same source', () => {
    const res = clipAndMergeZones(
      [
        zone({ sourceId: 'jp.gsi.flood-l2', offset: 0 }),
        zone({ sourceId: 'jp.gsi.flood-l2', offset: 0.01 }),
      ],
      FUKUI,
      20,
    )

    expect(res.zones).toHaveLength(1)
  })

  /**
   * Japan now queries three flood products at once: a real-time risk grid, an assumed-maximum
   * planning map and a global 100-year model. Keying the merge on hazard class alone unions a
   * キキクル level-4 *forecast* into a GSI *scenario* polygon and stamps the result with whichever
   * provider happened to run first — which is ADR-2's "narrate the scenario map as tonight's
   * forecast" arriving as a silent data merge rather than as a type error.
   */
  it('never merges a real-time forecast into a planning scenario', () => {
    const res = clipAndMergeZones(
      [
        zone({ sourceId: 'jp.gsi.flood-l2' }),
        zone({
          sourceId: 'jp.jma.kikikuru',
          kind: { kind: 'forecast', validFrom: 1_756_512_000_000, validTo: 1_756_512_600_000 },
        }),
      ],
      FUKUI,
      20,
    )

    expect(res.zones).toHaveLength(2)
    expect(res.zones.map((z) => z.kind.kind).sort()).toEqual(['forecast', 'scenario'])
  })

  it('keeps two sources apart even when they agree on the class and the kind', () => {
    const res = clipAndMergeZones(
      [zone({ sourceId: 'jp.gsi.flood-l2' }), zone({ sourceId: 'global.copernicus.glofas' })],
      FUKUI,
      20,
    )

    // Two maps disagreeing about the same ground is information; one polygon carrying one of their
    // names is not (R2.2).
    expect(res.zones).toHaveLength(2)
    expect(res.zones.map((z) => z.provenance.sourceId).sort()).toEqual([
      'global.copernicus.glofas',
      'jp.gsi.flood-l2',
    ])
  })

  it('gives every merged zone provenance that genuinely describes it', () => {
    const res = clipAndMergeZones(
      [
        zone({ sourceId: 'jp.gsi.flood-l2', offset: 0 }),
        zone({ sourceId: 'jp.gsi.flood-l2', offset: 0.01 }),
      ],
      FUKUI,
      20,
    )

    expect(res.zones[0]?.provenance.sourceId).toBe('jp.gsi.flood-l2')
    expect(res.zones[0]?.kind.kind).toBe('scenario')
  })

  it('drops a zone that falls entirely outside the query circle', () => {
    const faraway: FloodZone = zone({ sourceId: 'jp.gsi.flood-l2' })
    const res = clipAndMergeZones([faraway], { latitude: 35.68, longitude: 139.76 }, 5)

    expect(res.zones).toEqual([])
  })
})
