import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { StadiaRoutingProvider, decodePolyline6, toExcludePolygons } from './stadia'
import type { SafeFacility } from '../../../domain/places'
import type { RouteQuery } from '../../../ports/Routing'

/**
 * Routing through Stadia Maps, which runs Valhalla — so the replies below are real Valhalla
 * replies, and the parser is the same one the recorded fixtures go through.
 *
 * Snapping to real roads is the difference between a line a walker can follow and one drawn
 * through the buildings between them. These cover the parts that decide whether the drawn line
 * lands on the street: the six-digit polyline, the engine's manoeuvre vocabulary, and the flood
 * polygons handed over for it to route around.
 */

const provenance = {
  sourceId: 's',
  sourceName: 'S',
  upstreamUrl: 'https://example.com',
  retrievedAt: 0,
  cache: { hit: false, ageMs: 0 },
  licence: 'MIT',
  attribution: 'T',
  mode: 'fixture' as const,
}

const destination: SafeFacility = {
  id: 'jp-sim-fac-1',
  name: '指定緊急避難場所 (北部地区センター)',
  category: 'evacuation_site',
  at: { latitude: 35.5737, longitude: 139.4667 },
  metres: 720,
  bearing: 20,
  risk: 'clear',
  provenance,
}

const query: RouteQuery = {
  origin: { latitude: 35.5677, longitude: 139.4637 },
  destinations: [destination],
  costing: 'pedestrian',
}

/** A real reply from valhalla1.openstreetmap.de, trimmed to the fields we read. */
const valhallaReply = (overrides: Record<string, unknown> = {}) => ({
  trip: {
    legs: [
      {
        // A real shape prefix returned by valhalla1.openstreetmap.de for this origin.
        shape: SHAPE,
        summary: { length: 0.937, time: 655.122 },
        maneuvers: [
          { type: 3, instruction: 'Walk north.', length: 0.062, time: 44, begin_shape_index: 0 },
          { type: 15, instruction: 'Turn left.', length: 0.086, time: 62, begin_shape_index: 1 },
          {
            type: 10,
            instruction: 'Turn right onto 鶴川街道.',
            street_names: ['鶴川街道', 'Turukawa kaido'],
            length: 0.172,
            time: 124,
            begin_shape_index: 2,
          },
          { type: 4, instruction: 'You have arrived.', length: 0, time: 0, begin_shape_index: 3 },
        ],
      },
    ],
    summary: { length: 0.937, time: 655.122 },
  },
  ...overrides,
})

/** Verbatim from a live reply, so the decoder is tested against what the engine really emits. */
const SHAPE = 'ma{ybAqqe_iGuAUkEHwANsLdCsG~AOlDc@~Fa@dDiAfGwBdG{BjGi@dAq@dA'

const jsonResponse = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 502, json: async () => body }) as Response

describe('decoding the road geometry', () => {
  it('reads a precision-six polyline, not a precision-five one', () => {
    const positions = decodePolyline6(SHAPE)

    // Precision five would divide by 1e5 and land the walk ten degrees out to sea.
    expect(positions[0]).toEqual([139.463977, 35.567655])
    expect(positions.length).toBeGreaterThan(10)
    for (const [lon, lat] of positions) {
      expect(lon).toBeGreaterThan(139.4)
      expect(lon).toBeLessThan(139.5)
      expect(lat).toBeGreaterThan(35.5)
      expect(lat).toBeLessThan(35.6)
    }
  })

  it('traces a path with many vertices, which is what following a street looks like', () => {
    // A route snapped to roads bends constantly; two points would mean a line drawn through
    // whatever lies between.
    expect(decodePolyline6(SHAPE).length).toBeGreaterThan(10)
  })

  it('returns nothing for an empty shape rather than a phantom point', () => {
    expect(decodePolyline6('')).toEqual([])
  })
})

describe('handing flood zones to the engine', () => {
  it('sends a polygon as the single ring Valhalla expects', () => {
    const ring = [
      [139.46, 35.56],
      [139.47, 35.56],
      [139.47, 35.57],
      [139.46, 35.57],
      [139.46, 35.56],
    ]
    expect(
      toExcludePolygons([{ type: 'Polygon', coordinates: [ring] }]),
    ).toEqual([ring])
  })

  it('flattens a multipolygon into one ring per part', () => {
    const ringA = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    const ringB = [[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]
    expect(
      toExcludePolygons([{ type: 'MultiPolygon', coordinates: [[ringA], [ringB]] }]),
    ).toEqual([ringA, ringB])
  })

  it('drops a degenerate ring the engine would reject', () => {
    expect(toExcludePolygons([{ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }])).toEqual([])
  })
})

describe('routing on the real road network', () => {
  it('returns the engine geometry, so the line follows streets rather than cutting across', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(valhallaReply()))
    const provider = new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch)

    const result = await Effect.runPromise(provider.route(query))
    const [first] = result.results
    expect(first?.ok).toBe(true)
    if (!first?.ok) return

    expect(first.route.geometry.coordinates.length).toBeGreaterThan(1)
    expect(first.route.metres).toBe(937)
    expect(first.route.seconds).toBe(655)
    expect(first.route.provenance.mode).toBe('live')
    expect(result.engineNotes).toMatch(/OSM road network/)
  })

  it('carries the engine manoeuvres and street names into the steps', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(valhallaReply()))
    const provider = new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch)

    const result = await Effect.runPromise(provider.route(query))
    const first = result.results[0]
    if (!first?.ok) throw new Error('expected a route')

    expect(first.route.steps.map((s) => s.maneuver)).toEqual(['depart', 'left', 'right', 'arrive'])
    expect(first.route.steps[2]!.streetNames).toEqual(['鶴川街道', 'Turukawa kaido'])
    expect(first.route.steps[2]!.metres).toBe(172)
    expect(first.route.steps[0]!.at).toBeDefined()
  })

  it('asks the engine to route around the flood zones it was given', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return jsonResponse(valhallaReply())
    }) as unknown as typeof fetch
    const provider = new StadiaRoutingProvider(fetchImpl)

    await Effect.runPromise(
      provider.route({
        ...query,
        exclusions: [
          {
            type: 'Polygon',
            coordinates: [[[139.464, 35.569], [139.468, 35.569], [139.468, 35.572], [139.464, 35.572], [139.464, 35.569]]],
          },
        ],
      }),
    )

    expect(calls[0]![0]).toBe('/api/geo/route')
    const body = JSON.parse(calls[0]![1]!.body as string)
    expect(body.exclude_polygons).toHaveLength(1)
    expect(body.costing).toBe('pedestrian')
    expect(body.locations).toEqual([
      { lat: 35.5677, lon: 139.4637 },
      { lat: 35.5737, lon: 139.4667 },
    ])
  })

  it('marks exclusions as requested only when polygons were actually sent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(valhallaReply()))
    const provider = new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch)

    const without = await Effect.runPromise(provider.route(query))
    const first = without.results[0]
    if (!first?.ok) throw new Error('expected a route')
    expect(first.route.exclusions).toBe('not_requested')
  })

  describe('offering more than one way round', () => {
    /** A second real reply: verbatim from the engine, a genuinely different way to the same place. */
    const ALT_SHAPE =
      '{yx`cAisuqiGoFwAo@hEnZ`IbFrA`KlCsB~J~MrDu@|EyAxJa@pCRpBY|B~ALU~AW~AmAdIxG`UTr@JzGdAZdF|ArCx@v@qATMdc@mWjAWlVdGjEfAzDbA|~@jWb@zAv@jCkBxNaCa@VgAEtAzEx@k@rEqAtJ`Cl@tFtAvHdBtK~BcDdVnUjF'

    const withAlternates = () => ({
      ...valhallaReply(),
      alternates: [
        {
          trip: {
            legs: [
              {
                shape: ALT_SHAPE,
                summary: { length: 0.811, time: 635 },
                maneuvers: [
                  { type: 3, instruction: 'Walk north.', length: 0.1, time: 70, begin_shape_index: 0 },
                  { type: 4, instruction: 'You have arrived.', length: 0, time: 0, begin_shape_index: 3 },
                ],
              },
            ],
          },
        },
      ],
    })

    it('asks the engine for alternatives when more than one candidate is wanted', async () => {
      const calls: Array<RequestInit | undefined> = []
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        calls.push(init)
        return jsonResponse(withAlternates())
      }) as unknown as typeof fetch

      await Effect.runPromise(
        new StadiaRoutingProvider(fetchImpl).route({ ...query, candidatesPerDestination: 3 }),
      )

      // Valhalla counts alternates on top of the trip it always returns, so three ways round is
      // two alternates. Asking for three would quietly offer four.
      expect(JSON.parse(calls[0]!.body as string).alternates).toBe(2)
    })

    it('does not ask for alternatives when only one route is wanted', async () => {
      const calls: Array<RequestInit | undefined> = []
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        calls.push(init)
        return jsonResponse(valhallaReply())
      }) as unknown as typeof fetch

      await Effect.runPromise(new StadiaRoutingProvider(fetchImpl).route(query))
      expect(JSON.parse(calls[0]!.body as string).alternates).toBeUndefined()
    })

    it('returns the preferred trip and its alternatives as separate candidates', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(withAlternates()))
      const result = await Effect.runPromise(
        new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch).route({
          ...query,
          candidatesPerDestination: 2,
        }),
      )

      expect(result.results).toHaveLength(2)
      const routes = result.results.flatMap((r) => (r.ok ? [r.route] : []))
      // Both lead to the same shelter; the engine's own preference comes first.
      expect(routes.map((r) => r.destination.id)).toEqual(['jp-sim-fac-1', 'jp-sim-fac-1'])
      expect(routes.map((r) => r.metres)).toEqual([937, 811])
      // Two different paths, not one reply counted twice.
      expect(routes[0]!.geometry).not.toEqual(routes[1]!.geometry)
      expect(routes.every((r) => r.network === 'road')).toBe(true)
    })
  })

  describe('refusing geometry that is not a road route', () => {
    /**
     * The engine is asked for a path along streets. A reply that is a line between the endpoints
     * is not one, and taking it on trust would put the promise the map makes — that a drawn route
     * is a route — in the hands of whatever the proxy happens to return.
     */
    const crowFlightReply = {
      trip: {
        // Two points and 156 m of nothing in between — a bearing, encoded as a polyline.
        legs: [
          { shape: 'ma{ybAqqe_iG_}@_kA', summary: { length: 0.156, time: 120 }, maneuvers: [] },
        ],
      },
    }

    it('falls back rather than drawing a straight line the engine called a route', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(crowFlightReply))
      const result = await Effect.runPromise(
        new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch).route(query),
      )

      const first = result.results[0]
      if (!first?.ok) throw new Error('expected a fallback result')
      // Not presented as a live road route: the fallback provider answered instead.
      expect(first.route.provenance.mode).toBe('fixture')
      expect(first.route.network).not.toBe('road')
    })

    it('keeps the candidates that do follow roads and drops the one that does not', async () => {
      const mixed = {
        ...valhallaReply(),
        alternates: [{ trip: crowFlightReply.trip }],
      }
      const fetchImpl = vi.fn(async () => jsonResponse(mixed))
      const result = await Effect.runPromise(
        new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch).route({
          ...query,
          candidatesPerDestination: 2,
        }),
      )

      const routes = result.results.flatMap((r) => (r.ok ? [r.route] : []))
      expect(routes).toHaveLength(1)
      expect(routes[0]!.metres).toBe(937)
      expect(routes[0]!.provenance.mode).toBe('live')
    })
  })

  describe('when the engine cannot be reached', () => {
    it('falls back to the simulated provider rather than losing the route', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
      const provider = new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch)

      const result = await Effect.runPromise(provider.route(query))
      const first = result.results[0]
      expect(first?.ok).toBe(true)
      if (!first?.ok) return
      // Still labelled simulated, so nothing downstream presents it as a real road route.
      expect(first.route.provenance.mode).toBe('fixture')
    })

    it('falls back when the proxy is not in live mode', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, mode: 'fixture', data: null }))
      const provider = new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch)

      const result = await Effect.runPromise(provider.route(query))
      const first = result.results[0]
      if (!first?.ok) throw new Error('expected a fallback route')
      expect(first.route.provenance.mode).toBe('fixture')
    })

    it('says why it fell back, rather than quietly serving recordings', async () => {
      // What the proxy answers when ROUTING_API_KEY is unset. Without this note nothing anywhere
      // tells the reader that a key is all that stands between them and live routing.
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          {
            error: 'RoutingAuthRequired',
            message:
              'api.stadiamaps.com rejected the routing request (HTTP 401). Set ROUTING_API_KEY to a Stadia Maps API key.',
          },
          false,
        ),
      )
      const result = await Effect.runPromise(
        new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch).route(query),
      )

      expect(result.engineNotes).toContain('Stadia Maps was not used')
      expect(result.engineNotes).toContain('ROUTING_API_KEY')
      expect(result.results[0]?.ok).toBe(true)
    })

    it('falls back on a reply carrying no geometry', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ trip: { legs: [{}] } }))
      const provider = new StadiaRoutingProvider(fetchImpl as unknown as typeof fetch)

      const result = await Effect.runPromise(provider.route(query))
      expect(result.results[0]?.ok).toBe(true)
    })
  })
})
