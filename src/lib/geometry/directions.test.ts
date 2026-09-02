import { describe, expect, it } from 'vitest'
import type { LineString } from 'geojson'
import {
  bearingBetween,
  buildTurnByTurnSteps,
  maneuverForTurn,
  metresBetween,
  turnAngle,
  withDerivedManeuvers,
} from './directions'
import type { RouteStep } from '../../domain/routing'

/**
 * The arrow a reader follows and the line drawn on the map both come from these vertices, so a
 * manoeuvre that disagrees with the geometry would send someone the wrong way at a junction.
 */

const line = (coordinates: ReadonlyArray<[number, number]>): LineString => ({
  type: 'LineString',
  coordinates: [...coordinates],
})

describe('bearings and turns', () => {
  it('reads due north, east, south and west off the compass', () => {
    const origin = { latitude: 35.5, longitude: 139.5 }
    expect(bearingBetween(origin, { latitude: 35.51, longitude: 139.5 })).toBeCloseTo(0, 1)
    expect(bearingBetween(origin, { latitude: 35.5, longitude: 139.51 })).toBeCloseTo(90, 1)
    expect(bearingBetween(origin, { latitude: 35.49, longitude: 139.5 })).toBeCloseTo(180, 1)
    expect(bearingBetween(origin, { latitude: 35.5, longitude: 139.49 })).toBeCloseTo(270, 1)
  })

  it('signs a turn left as negative and right as positive', () => {
    expect(turnAngle(0, 90)).toBe(90)
    expect(turnAngle(90, 0)).toBe(-90)
    // Across the 360/0 seam, where a naive subtraction would report 350° instead of -10°.
    expect(turnAngle(350, 10)).toBe(20)
    expect(turnAngle(10, 350)).toBe(-20)
  })

  it.each([
    [0, 'straight'],
    [19, 'straight'],
    [-19, 'straight'],
    [30, 'slight-right'],
    [-30, 'slight-left'],
    [90, 'right'],
    [-90, 'left'],
    [120, 'sharp-right'],
    [-120, 'sharp-left'],
    [175, 'uturn'],
    [-175, 'uturn'],
  ])('classifies a %i° turn as %s', (angle, expected) => {
    expect(maneuverForTurn(angle)).toBe(expected)
  })

  it('measures distance close enough to walk by', () => {
    // One degree of latitude is about 111 km.
    expect(metresBetween({ latitude: 35, longitude: 139 }, { latitude: 35.01, longitude: 139 })).toBeCloseTo(1112, -1)
  })
})

describe('building steps from a bare polyline', () => {
  // North, then east, then north again: the shape a street grid forces on an approach.
  const dogLeg = line([
    [139.4637, 35.5677],
    [139.4637, 35.5716],
    [139.4661, 35.5716],
    [139.4667, 35.5737],
  ])

  const steps = buildTurnByTurnSteps({
    geometry: dogLeg,
    destinationName: 'North District Centre',
    totalMetres: 890,
    totalSeconds: 742,
  })

  it('opens with a departure and closes with an arrival', () => {
    expect(steps[0]!.maneuver).toBe('depart')
    expect(steps[0]!.instruction).toMatch(/^Head N /)
    expect(steps[steps.length - 1]!.maneuver).toBe('arrive')
    expect(steps[steps.length - 1]!.instruction).toBe('Arrive at North District Centre.')
    expect(steps[steps.length - 1]!.metres).toBe(0)
  })

  it('calls each turn the way the geometry actually bends', () => {
    expect(steps.map((s) => s.maneuver)).toEqual(['depart', 'right', 'left', 'arrive'])
  })

  it('adds the legs up to the distance the engine reported', () => {
    const total = steps.reduce((sum, step) => sum + step.metres, 0)
    expect(total).toBeGreaterThanOrEqual(888)
    expect(total).toBeLessThanOrEqual(892)
  })

  it('anchors every step to the point it begins at, so the map can be brought there', () => {
    expect(steps[0]!.at).toEqual({ longitude: 139.4637, latitude: 35.5677 })
    expect(steps[1]!.at).toEqual({ longitude: 139.4637, latitude: 35.5716 })
    expect(steps[steps.length - 1]!.at).toEqual({ longitude: 139.4667, latitude: 35.5737 })
  })

  it('folds a few-metre wobble into the leg before it rather than calling it a turn', () => {
    // A 5 m jog mid-leg: tracing a curve, not a junction.
    const wobbly = line([
      [139.4637, 35.5677],
      [139.4637, 35.5716],
      [139.46375, 35.57162],
      [139.4661, 35.5716],
    ])
    const derived = buildTurnByTurnSteps({ geometry: wobbly, destinationName: 'X' })
    expect(derived.map((s) => s.maneuver)).toEqual(['depart', 'right', 'arrive'])
  })

  it('gives a straight line a departure and an arrival, and claims no turns it cannot see', () => {
    const straight = buildTurnByTurnSteps({
      geometry: line([
        [139.4637, 35.5677],
        [139.4667, 35.5737],
      ]),
      destinationName: 'X',
    })
    expect(straight.map((s) => s.maneuver)).toEqual(['depart', 'arrive'])
  })

  it('returns nothing for a degenerate line rather than inventing a route', () => {
    expect(buildTurnByTurnSteps({ geometry: line([[139.4, 35.5]]), destinationName: 'X' })).toEqual([])
    expect(
      buildTurnByTurnSteps({
        geometry: line([
          [139.4, 35.5],
          [139.4, 35.5],
        ]),
        destinationName: 'X',
      }),
    ).toEqual([])
  })

  it('estimates duration from walking speed when the engine gave none', () => {
    const derived = buildTurnByTurnSteps({
      geometry: dogLeg,
      destinationName: 'X',
      totalMetres: 900,
      speedMetresPerSecond: 1.5,
    })
    const seconds = derived.reduce((sum, step) => sum + step.seconds, 0)
    expect(seconds).toBeCloseTo(600, -1)
  })
})

describe('filling in manoeuvres an engine left out', () => {
  const geometry = line([
    [139.767, 35.681],
    [139.761, 35.677],
    [139.756, 35.674],
  ])

  it('keeps a manoeuvre the engine did classify', () => {
    const steps: ReadonlyArray<RouteStep> = [
      { instruction: 'Walk southwest.', metres: 450, seconds: 360, maneuver: 'depart' },
      { instruction: 'Turn left into the park.', metres: 400, seconds: 320, maneuver: 'left' },
    ]
    expect(withDerivedManeuvers(steps, geometry).map((s) => s.maneuver)).toEqual(['depart', 'left'])
  })

  it('derives the missing ones and anchors them to the geometry', () => {
    const steps: ReadonlyArray<RouteStep> = [
      { instruction: 'Walk southwest.', metres: 450, seconds: 360 },
      { instruction: 'Continue.', metres: 400, seconds: 320 },
    ]
    const filled = withDerivedManeuvers(steps, geometry)

    expect(filled[0]!.maneuver).toBe('depart')
    expect(filled[0]!.at).toEqual({ longitude: 139.767, latitude: 35.681 })
    expect(filled[1]!.maneuver).toBeDefined()
    expect(filled[1]!.at).toBeDefined()
  })

  it('leaves the instructions and distances exactly as the engine wrote them', () => {
    const steps: ReadonlyArray<RouteStep> = [
      { instruction: 'Walk southwest on Marunouchi Street.', metres: 450, seconds: 360, streetNames: ['Marunouchi Street'] },
    ]
    const [filled] = withDerivedManeuvers(steps, geometry)
    expect(filled!.instruction).toBe('Walk southwest on Marunouchi Street.')
    expect(filled!.metres).toBe(450)
    expect(filled!.streetNames).toEqual(['Marunouchi Street'])
  })

  it('passes an empty or ungeometried step list straight through', () => {
    expect(withDerivedManeuvers([], geometry)).toEqual([])
    const steps: ReadonlyArray<RouteStep> = [{ instruction: 'Go.', metres: 10, seconds: 8 }]
    expect(withDerivedManeuvers(steps, line([[139.4, 35.5]]))).toEqual(steps)
  })
})
