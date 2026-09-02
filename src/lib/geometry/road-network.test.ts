import { describe, expect, it } from 'vitest'
import type { LineString } from 'geojson'
import {
  assessRoadAdherence,
  describeRoadAdherence,
  followsRoadNetwork,
} from './road-network'
import { decodePolyline6 } from '../../adapters/geo/routing/valhalla-trip'

/**
 * The one question this answers is whether a drawn line could have been traced along streets.
 * Everything downstream — what the map draws, what the directions panel narrates, what a reader
 * is invited to walk during an evacuation — rests on it, so the cases below are the shapes that
 * actually turn up: engine output, a bearing drawn as a line, and the approximations in between.
 */

const line = (coordinates: ReadonlyArray<[number, number]>): LineString => ({
  type: 'LineString',
  coordinates: coordinates.map(([lon, lat]) => [lon, lat]),
})

/** Verbatim from valhalla1.openstreetmap.de: a 937 m pedestrian walk in Inagi, Tokyo. */
const REAL_SHAPE = 'ma{ybAqqe_iGuAUkEHwANsLdCsG~AOlDc@~Fa@dDiAfGwBdG{BjGi@dAq@dA'

/** The same two endpoints, joined by a straight line: what a bearing looks like drawn. */
const CROW_FLIGHT = line([
  [139.463977, 35.567655],
  [139.4667, 35.5737],
])

describe('telling a routed path from a line drawn between two points', () => {
  it('accepts geometry the engine actually returned', () => {
    const geometry: LineString = { type: 'LineString', coordinates: decodePolyline6(REAL_SHAPE) }
    const report = assessRoadAdherence(geometry)

    expect(report.followsRoadNetwork).toBe(true)
    expect(report.reason).toBe('road-shaped')
    expect(report.vertexCount).toBeGreaterThan(10)
    // It bends round things rather than going straight at them.
    expect(report.detourRatio).toBeGreaterThan(1)
  })

  it('rejects a crow-flight between the same two points', () => {
    const report = assessRoadAdherence(CROW_FLIGHT)

    expect(report.followsRoadNetwork).toBe(false)
    expect(report.reason).toBe('crow-flight')
    expect(report.detourRatio).toBeCloseTo(1, 5)
    expect(describeRoadAdherence(report)).toMatch(/straight line/)
  })

  it('rejects the L-shaped approximation that reads as a path but is not one', () => {
    // Plausible-looking: it turns a corner. The corner is arithmetic, not a junction.
    const lShaped = line([
      [139.4637, 35.5677],
      [139.4667, 35.5677],
      [139.4667, 35.5722],
      [139.4667, 35.5737],
    ])

    const report = assessRoadAdherence(lShaped)
    expect(report.followsRoadNetwork).toBe(false)
    expect(report.reason).toBe('too-few-shape-points')
  })

  it('rejects a long path whose shape points are hundreds of metres apart', () => {
    // Five points, so the count alone passes; spaced far too widely to have come off a network.
    const sparse = line([
      [139.46, 35.56],
      [139.47, 35.565],
      [139.48, 35.57],
      [139.49, 35.575],
      [139.5, 35.58],
    ])

    const report = assessRoadAdherence(sparse)
    expect(report.followsRoadNetwork).toBe(false)
    expect(report.reason).toBe('shape-points-too-sparse')
    expect(describeRoadAdherence(report)).toMatch(/too sparse/)
  })

  it('accepts a short straight hop, which an engine really can return', () => {
    // The last few metres across a forecourt: one snapped segment, and shape cannot condemn it.
    const report = assessRoadAdherence(
      line([
        [139.4637, 35.5677],
        [139.46375, 35.56795],
      ]),
    )

    expect(report.followsRoadNetwork).toBe(true)
    expect(report.reason).toBe('short-enough-for-one-segment')
  })

  it('rejects geometry that is not a path at all', () => {
    expect(assessRoadAdherence(line([[139.46, 35.56]])).reason).toBe('degenerate')
    expect(
      assessRoadAdherence(
        line([
          [139.46, 35.56],
          [139.46, 35.56],
        ]),
      ).reason,
    ).toBe('degenerate')
  })

  it('answers the same question through the shorthand', () => {
    expect(followsRoadNetwork(CROW_FLIGHT)).toBe(false)
    expect(
      followsRoadNetwork({ type: 'LineString', coordinates: decodePolyline6(REAL_SHAPE) }),
    ).toBe(true)
  })
})
