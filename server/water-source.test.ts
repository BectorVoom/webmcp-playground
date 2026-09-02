import { describe, expect, it } from 'vitest'
import { overpassWaterQuery, parseOverpassWater, stitchRings } from './water-source'

describe('the Overpass water query', () => {
  it('asks for relations as well as ways', () => {
    // The bug this guards: every lake worth the name is a multipolygon relation,
    // so a way-only query returns a confident list of ponds and silently omits
    // the largest body of water in the window.
    const query = overpassWaterQuery([138.0, 36.5, 138.5, 36.9])
    expect(query).toContain('relation["natural"="water"]')
    expect(query).toContain('way["natural"="water"]')
    expect(query).toContain('relation["landuse"="reservoir"]')
  })

  it('excludes intermittent water, which is land that floods', () => {
    // An ephemeral wash is dry most of the time, so masking it would delete the
    // flash-flood hazard rather than a lake. 40% of water around Tucson carries
    // this tag against 5.6% at Joso, so the Japanese calibration never saw it.
    const query = overpassWaterQuery([138.0, 36.5, 138.5, 36.9])
    expect(query).toContain('["intermittent"!="yes"]')
    expect(query.match(/\["intermittent"!="yes"\]/g)).toHaveLength(4)
  })

  it('orders the bbox as Overpass expects: south, west, north, east', () => {
    expect(overpassWaterQuery([138.0, 36.5, 138.5, 36.9])).toContain(
      '36.50000,138.00000,36.90000,138.50000',
    )
  })
})

describe('stitching relation members into rings', () => {
  it('joins segments that share endpoints into one closed ring', () => {
    const rings = stitchRings([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 1],
      ],
      [
        [1, 0],
        [1, 1],
      ],
      [
        [0, 1],
        [0, 0],
      ],
    ])
    expect(rings).toHaveLength(1)
    expect(rings[0]!.length).toBeGreaterThanOrEqual(4)
    expect(rings[0]![0]).toEqual(rings[0]![rings[0]!.length - 1])
  })

  it('reverses a segment that joins tail-first', () => {
    const rings = stitchRings([
      [
        [0, 0],
        [1, 0],
      ],
      // Same edge as above but written backwards; it still has to attach.
      [
        [1, 1],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 0],
      ],
    ])
    expect(rings).toHaveLength(1)
    expect(rings[0]![0]).toEqual(rings[0]![rings[0]!.length - 1])
  })

  it('keeps two disjoint loops apart rather than merging them', () => {
    const rings = stitchRings([
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      [
        [5, 5],
        [6, 5],
        [6, 6],
        [5, 5],
      ],
    ])
    expect(rings).toHaveLength(2)
  })
})

describe('parsing an Overpass water reply', () => {
  it('reads a way as a single-ring body', () => {
    const parsed = parseOverpassWater(
      JSON.stringify({
        elements: [
          {
            type: 'way',
            geometry: [
              { lat: 36.0, lon: 138.0 },
              { lat: 36.0, lon: 138.1 },
              { lat: 36.1, lon: 138.1 },
            ],
          },
        ],
      }),
    )
    expect(parsed?.wayCount).toBe(1)
    expect(parsed?.relationCount).toBe(0)
    expect(parsed?.bodies[0]!.rings).toHaveLength(1)
  })

  it('reads a relation, stitching its outer members and keeping inner ones as holes', () => {
    const parsed = parseOverpassWater(
      JSON.stringify({
        elements: [
          {
            type: 'relation',
            members: [
              {
                role: 'outer',
                geometry: [
                  { lat: 36.0, lon: 138.0 },
                  { lat: 36.0, lon: 138.2 },
                ],
              },
              {
                role: 'outer',
                geometry: [
                  { lat: 36.0, lon: 138.2 },
                  { lat: 36.2, lon: 138.0 },
                  { lat: 36.0, lon: 138.0 },
                ],
              },
              {
                role: 'inner',
                geometry: [
                  { lat: 36.05, lon: 138.05 },
                  { lat: 36.05, lon: 138.07 },
                  { lat: 36.07, lon: 138.05 },
                  { lat: 36.05, lon: 138.05 },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(parsed?.relationCount).toBe(1)
    // One stitched outer ring plus the island.
    expect(parsed?.bodies[0]!.rings).toHaveLength(2)
  })

  it('returns null for an unreadable body rather than an empty lake list', () => {
    // The two must be distinguishable: no water and no answer are different facts.
    expect(parseOverpassWater('not json')).toBeNull()
    expect(parseOverpassWater(JSON.stringify({ nope: true }))).toBeNull()
    expect(parseOverpassWater(JSON.stringify({ elements: [] }))).toEqual({
      bodies: [],
      wayCount: 0,
      relationCount: 0,
    })
  })

  it('drops an intermittent body even when the reply contains one', () => {
    // Defence in depth for the fetch path: the query already excludes these, but
    // a reply must not be trusted to have honoured it.
    const ring = [
      { lat: 36.0, lon: 138.0 },
      { lat: 36.0, lon: 138.1 },
      { lat: 36.1, lon: 138.1 },
    ]
    const parsed = parseOverpassWater(
      JSON.stringify({
        elements: [
          { type: 'way', tags: { natural: 'water', intermittent: 'yes' }, geometry: ring },
          { type: 'way', tags: { natural: 'water', seasonal: 'yes' }, geometry: ring },
          { type: 'way', tags: { natural: 'water' }, geometry: ring },
        ],
      }),
    )
    expect(parsed?.wayCount).toBe(1)
    expect(parsed?.bodies).toHaveLength(1)
  })

  it('skips a way with too few usable vertices', () => {
    const parsed = parseOverpassWater(
      JSON.stringify({
        elements: [{ type: 'way', geometry: [{ lat: 36.0, lon: 138.0 }] }],
      }),
    )
    expect(parsed?.bodies).toHaveLength(0)
  })
})
