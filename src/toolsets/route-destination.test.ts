import { describe, expect, it, beforeEach } from 'vitest'
import { Effect } from 'effect'
import {
  disasterToolSet,
  setDisasterDataMode,
  setDisasterGeolocationPort,
  setDisasterMapPort,
} from './disaster'
import { findFacilitiesByName } from '../app/hazard/routing-service'
import { publishSchema } from '../domain/schema'
import { MemoryMapAdapter } from '../adapters/map/memory-map'
import { BrowserGeolocationAdapter } from '../adapters/geo/browser-geolocation'
import type { LineString } from 'geojson'
import { followsRoadNetwork } from '../lib/geometry/road-network'
import type { SafeFacility } from '../domain/places'
import type { AnyToolDefinition } from '../domain/tool'

/**
 * "Please display route to 指定緊急避難場所 (北部地区センター)" used to be inexpressible: the tool
 * routed only to facilities it ranked itself, so a named destination had no parameter to land in.
 * The model saw origin coordinates, read them as the destination's, and answered that it needed
 * latitude and longitude for the shelter — a question the user cannot reasonably answer.
 */

const NORTH = '指定緊急避難場所 (北部地区センター)'

const provenance = {
  sourceId: 'test.source',
  sourceName: 'Test Source',
  upstreamUrl: 'https://example.com',
  retrievedAt: 0,
  cache: { hit: false, ageMs: 0 },
  licence: 'MIT',
  attribution: 'Test',
  mode: 'fixture' as const,
}

const facility = (id: string, name: string): SafeFacility => ({
  id,
  name,
  category: 'evacuation_site',
  at: { latitude: 35.57, longitude: 139.47 },
  metres: 720,
  bearing: 20,
  risk: 'clear',
  provenance,
})

describe('resolving a destination the user named', () => {
  const facilities = [
    facility('jp-sim-fac-1', NORTH),
    facility('jp-sim-fac-2', '指定避難所 (東部コミュニティスクール)'),
    facility('jp-sim-fac-3', '広域避難拠点 (南部防災交流館)'),
  ]

  it.each([
    ['the full name as listed', NORTH],
    ['only the parenthesised part', '北部地区センター'],
    ['full-width parentheses', '指定緊急避難場所（北部地区センター）'],
    ['stray whitespace', '  指定緊急避難場所  (北部地区センター) '],
    ['the facility id', 'jp-sim-fac-1'],
  ])('matches %s', (_label, query) => {
    expect(findFacilitiesByName(facilities, query).map((f) => f.name)).toEqual([NORTH])
  })

  it('matches nothing for a name that is not in range', () => {
    expect(findFacilitiesByName(facilities, '横浜アリーナ')).toEqual([])
  })

  it('matches nothing for an empty or blank query', () => {
    expect(findFacilitiesByName(facilities, '')).toEqual([])
    expect(findFacilitiesByName(facilities, '   ')).toEqual([])
  })

  it('prefers an exact name over a substring of a longer one', () => {
    const both = [facility('a', '中央体育館'), facility('b', '第2中央体育館 別館')]
    expect(findFacilitiesByName(both, '中央体育館').map((f) => f.id)).toEqual(['a'])
  })
})

describe('disaster.evacuation_routes routes to a named shelter', () => {
  const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.evacuation_routes')!
  let mapPort: MemoryMapAdapter

  beforeEach(() => {
    setDisasterDataMode('fixture')
    mapPort = new MemoryMapAdapter()
    setDisasterMapPort(mapPort)
    const geo = new BrowserGeolocationAdapter()
    geo.setPinnedPosition({
      coordinates: { latitude: 35.5677, longitude: 139.4637 },
      accuracyMetres: 35,
      source: 'pinned',
      resolvedAt: Date.now(),
    })
    setDisasterGeolocationPort(geo)
  })

  const run = (input: Record<string, unknown>) =>
    Effect.runPromise(Effect.either(tool.execute(input as never, {} as never)))

  it.each([NORTH, '北部地区センター', '指定緊急避難場所（北部地区センター）'])(
    'plans for that one shelter alone when asked for "%s"',
    async (destination) => {
      const result = await run({ destination })

      expect(result._tag).toBe('Right')
      if (result._tag !== 'Right') return
      const text = result.right.content[0]!.text
      expect(text).toContain(NORTH)
      // The other shelters in range are not planned for.
      expect(text).not.toContain('東部コミュニティスクール')
      expect(text).not.toContain('南部防災交流館')
    },
  )

  /**
   * These shelters are simulated around wherever the reader happens to be, so fixture mode holds
   * no recorded path to them and cannot invent one that follows a street. Saying "400 m north" is
   * honest; drawing a line over whatever lies between is not, so nothing is drawn.
   */
  it('offers a distance rather than a drawn route where no road path is known', async () => {
    const result = await run({ destination: NORTH })

    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    const text = result.right.content[0]!.text
    expect(text).toContain('STRAIGHT-LINE DISTANCES — NOT ROUTES')
    expect(text).toContain('follow no road')

    const layer = await Effect.runPromise(mapPort.readLayer('routes'))
    expect(layer?.featureCount ?? 0).toBe(0)
  })

  it('still plans for several shelters when no destination is named', async () => {
    const result = await run({})

    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    const text = result.right.content[0]!.text
    expect(text).toContain(NORTH)
    expect(text).toContain('東部コミュニティスクール')
  })

  /**
   * Where a path along real streets is known, the tool draws it — and offers the ways round it
   * found, the way a navigation app does, with the safest first.
   */
  describe('at a location the recorded road network covers', () => {
    const TOKYO = { latitude: 35.6812, longitude: 139.7671 }

    it('draws several candidates to a named shelter, safest first', async () => {
      const result = await run({ ...TOKYO, destination: 'Tokyo International Forum' })

      expect(result._tag).toBe('Right')
      if (result._tag !== 'Right') return
      expect(result.right.content[0]!.text).toContain('Tokyo International Forum')

      const layer = await Effect.runPromise(mapPort.readLayer('routes'))
      expect(layer!.featureCount).toBeGreaterThan(1)

      const features = layer!.geojson.features
      for (const feature of features) {
        expect(feature.properties?.destination).toBe('Tokyo International Forum')
        expect(feature.properties?.network).toBe('road')
        expect(followsRoadNetwork(feature.geometry as LineString)).toBe(true)
      }

      // Rank 1 is the recommendation: the least of its length spent in flood water.
      const exposure = features.map((f) => Number(f.properties?.exposedMetres))
      expect([...exposure].sort((a, b) => a - b)).toEqual(exposure)
    })
  })

  it('lists the shelters in range when the name does not match', async () => {
    const result = await run({ destination: '横浜アリーナ' })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    // A bare refusal would strand the model; naming the candidates lets it retry in one step.
    expect(result.left.message).toContain('横浜アリーナ')
    expect(result.left.message).toContain(NORTH)
    expect(result.left.message).toMatch(/Retry with one of those names/)
  })

  it('treats a blank destination as "pick for me" rather than as no match', async () => {
    const result = await run({ destination: '   ' })
    expect(result._tag).toBe('Right')
  })
})

describe('the destination parameter is discoverable by the model', () => {
  const tool = disasterToolSet.tools.find(
    (t) => t.name === 'disaster.evacuation_routes',
  ) as AnyToolDefinition
  const schema = publishSchema(tool) as {
    required?: ReadonlyArray<string>
    properties?: Record<string, { type?: string; description?: string }>
  }

  it('publishes destination as an optional string', () => {
    expect(schema.properties?.destination?.type).toBe('string')
    expect(schema.required ?? []).not.toContain('destination')
  })

  it('points the model at find_shelters names and away from coordinates', () => {
    const description = schema.properties?.destination?.description ?? ''
    expect(description).toContain('disaster.find_shelters')
    expect(description).toMatch(/never put coordinates here/i)
  })

  it('says plainly that latitude and longitude are the starting point', () => {
    // The original misreading: the model took the origin fields for the destination's.
    expect(tool.description).toMatch(/starting point, never the destination/i)
    expect(tool.description).toContain('destination')
  })
})
