import { describe, expect, it, beforeEach } from 'vitest'
import { Effect } from 'effect'
import {
  disasterToolSet,
  setDisasterDataMode,
  setDisasterGeolocationPort,
  setDisasterMapPort,
} from './disaster'
import { MemoryMapAdapter } from '../adapters/map/memory-map'
import { BrowserGeolocationAdapter } from '../adapters/geo/browser-geolocation'
import type { LineString } from 'geojson'
import { followsRoadNetwork } from '../lib/geometry/road-network'
import type { ToolContext } from '../domain/tool'
import { createIdFactory } from '../domain/ids'
import { publishSchema } from '../domain/schema'

const ids = createIdFactory()

const makeCtx = (): ToolContext => ({
  signal: new AbortController().signal,
  callId: ids.newCallId(),
  turnId: ids.newTurnId(),
})

describe('Disaster Tool Set (Phase 8, Checkpoint 8)', () => {
  let mapAdapter: MemoryMapAdapter
  let geoAdapter: BrowserGeolocationAdapter

  beforeEach(() => {
    mapAdapter = new MemoryMapAdapter()
    geoAdapter = new BrowserGeolocationAdapter()
    geoAdapter.setPinnedPosition({
      coordinates: { latitude: 35.6812, longitude: 139.7671 },
      accuracyMetres: 20,
      source: 'pinned',
      resolvedAt: Date.now(),
    })
    setDisasterMapPort(mapAdapter)
    setDisasterGeolocationPort(geoAdapter)
    setDisasterDataMode('fixture')
  })

  it('declares 9 tools with flat schemas and honest annotations (8.1, 8.2)', () => {
    expect(disasterToolSet.tools.length).toBe(9)
    const names = disasterToolSet.tools.map((t) => t.name)
    expect(names).toEqual([
      'disaster.locate',
      'disaster.geocode',
      'disaster.flood_forecast',
      'disaster.inundation_model',
      'disaster.find_shelters',
      'disaster.evacuation_routes',
      'disaster.official_alerts',
      'disaster.focus_map',
      'disaster.clear_map',
    ])

    const alertsTool = disasterToolSet.tools.find((t) => t.name === 'disaster.official_alerts')
    expect(alertsTool?.annotations.readOnlyHint).toBe(true)
    expect(alertsTool?.annotations.untrustedContentHint).toBe(true)

    const locateTool = disasterToolSet.tools.find((t) => t.name === 'disaster.locate')
    expect(locateTool?.annotations.untrustedContentHint).toBe(false)

    // OSM place names are public free text and reach the model verbatim.
    const geocodeTool = disasterToolSet.tools.find((t) => t.name === 'disaster.geocode')
    expect(geocodeTool?.annotations.readOnlyHint).toBe(true)
    expect(geocodeTool?.annotations.untrustedContentHint).toBe(true)

    // Camera and layer controls mutate the visible page and must not be advertised as read-only.
    expect(
      disasterToolSet.tools.find((t) => t.name === 'disaster.focus_map')?.annotations.readOnlyHint,
    ).toBe(false)
    expect(
      disasterToolSet.tools.find((t) => t.name === 'disaster.clear_map')?.annotations.readOnlyHint,
    ).toBe(false)

    const sheltersSchema = publishSchema(
      disasterToolSet.tools.find((t) => t.name === 'disaster.find_shelters')!,
    )
    expect(sheltersSchema.properties).toMatchObject({
      latitude: { minimum: -90, maximum: 90 },
      longitude: { minimum: -180, maximum: 180 },
      radiusKm: { minimum: 1, maximum: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    })
  })

  describe('disaster.geocode', () => {
    const geocodeTool = () => disasterToolSet.tools.find((t) => t.name === 'disaster.geocode')!

    it('resolves a place name to coordinates and draws it on its own layer', async () => {
      const result = await Effect.runPromise(
        geocodeTool().execute({ query: 'Fukui Station' }, makeCtx()),
      )
      const text = result.content[0]?.text ?? ''

      expect(text).toContain('PLACE SEARCH')
      expect(text).toContain('福井駅')
      expect(text).toContain('latitude 36.0621')
      expect(text).toContain('longitude 136.2222')
      // Fixture mode must say so: these coordinates come from a closed list, not a geocoder.
      expect(text).toContain('SIMULATED DATA')

      const layer = await Effect.runPromise(mapAdapter.readLayer('search-results'))
      expect(layer?.featureCount).toBeGreaterThan(0)
      expect(layer?.geojson.features[0]?.properties?.name).toBe('福井駅')
    })

    it('tells the model exactly which tool call comes next', async () => {
      const result = await Effect.runPromise(
        geocodeTool().execute({ query: '福井駅', limit: 1 }, makeCtx()),
      )
      const text = result.content[0]?.text ?? ''

      expect(text).toContain('latitude=36.0621')
      expect(text).toContain('longitude=136.2222')
      expect(text).toContain('disaster.flood_forecast')
    })

    it('says which authority covers the place it resolved', async () => {
      const result = await Effect.runPromise(
        geocodeTool().execute({ query: 'Fukui Station', limit: 1 }, makeCtx()),
      )
      expect(result.content[0]?.text).toContain('Japan')
    })

    it('returns Aomori Station latitude for the natural-language search phrasing', async () => {
      const result = await Effect.runPromise(
        geocodeTool().execute({ query: 'Aomori station latitude', limit: 1 }, makeCtx()),
      )
      const text = result.content[0]?.text ?? ''

      expect(text).toContain('青森駅')
      expect(text).toContain('latitude 40.8289')
      expect(text).toContain('longitude 140.7336')
    })

    it('invents nothing for a name it cannot resolve', async () => {
      const result = await Effect.runPromise(
        geocodeTool().execute({ query: 'Nowhere At All Village' }, makeCtx()),
      )
      const text = result.content[0]?.text ?? ''

      expect(text).toContain('No match')
      expect(text).toContain('Do not guess coordinates')
      expect(text).not.toMatch(/latitude \d/)

      const layer = await Effect.runPromise(mapAdapter.readLayer('search-results'))
      expect(layer?.featureCount).toBe(0)
    })

    it('fails loudly on an empty query rather than resolving something arbitrary', async () => {
      const outcome = await Effect.runPromise(
        Effect.either(geocodeTool().execute({ query: '  ' }, makeCtx())),
      )

      expect(outcome._tag).toBe('Left')
      if (outcome._tag === 'Left') {
        expect(outcome.left.message).toContain('No place name')
      }
    })
  })

  it('executes disaster.locate and updates user-position map layer (8.3, 8.5)', async () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.locate')!
    const result = await Effect.runPromise(tool.execute({}, makeCtx()))

    expect(result.content[0]?.text).toContain('LOCATION RESOLVED')
    expect(result.content[0]?.text).toContain('35.6812')

    const layer = await Effect.runPromise(mapAdapter.readLayer('user-position'))
    expect(layer).toBeDefined()
    expect(layer?.featureCount).toBe(1)
  })

  it('executes disaster.flood_forecast and updates flood-zones layer (8.4)', async () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.flood_forecast')!
    const result = await Effect.runPromise(
      tool.execute({ latitude: 35.6812, longitude: 139.7671, radiusKm: 30 }, makeCtx()),
    )

    // Clamping notice
    expect(result.content[0]?.text).toContain('clamped to 20 km')
    expect(result.content[0]?.text).toContain('FLOOD HAZARD MAP')

    const layer = await Effect.runPromise(mapAdapter.readLayer('flood-zones'))
    expect(layer).toBeDefined()
    expect(layer?.featureCount).toBeGreaterThan(0)
  })

  it('executes disaster.find_shelters and updates facilities layer', async () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.find_shelters')!
    const result = await Effect.runPromise(
      tool.execute({ latitude: 35.6812, longitude: 139.7671, radiusKm: 10, limit: 3 }, makeCtx()),
    )

    expect(result.content[0]?.text).toContain('SAFE FACILITIES')
    expect(result.content[0]?.text).toContain('Facilities found')

    const layer = await Effect.runPromise(mapAdapter.readLayer('facilities'))
    expect(layer).toBeDefined()
    expect(layer?.featureCount).toBeLessThanOrEqual(3)
  })

  it('executes disaster.evacuation_routes and updates routes layer', async () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.evacuation_routes')!
    const result = await Effect.runPromise(
      tool.execute(
        { latitude: 35.6812, longitude: 139.7671, radiusKm: 20, mode: 'walk', limit: 2 },
        makeCtx(),
      ),
    )

    expect(result.content[0]?.text).toContain('EVACUATION ROUTES')
    expect(result.content[0]?.text).toContain('Route 1 to')

    // Several candidates, the way a navigation app offers a few ways round, and every one of them
    // a path along streets rather than a line drawn to the destination.
    const layer = await Effect.runPromise(mapAdapter.readLayer('routes'))
    expect(layer).toBeDefined()
    expect(layer!.featureCount).toBeGreaterThan(1)
    for (const feature of layer!.geojson.features) {
      expect(feature.properties?.network).toBe('road')
      expect(followsRoadNetwork(feature.geometry as LineString)).toBe(true)
    }
    expect(layer!.geojson.features.map((f) => f.properties?.rank)).toEqual(
      layer!.geojson.features.map((_, i) => i + 1),
    )
  })

  it('executes disaster.official_alerts with fenced output', async () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.official_alerts')!
    const result = await Effect.runPromise(
      tool.execute({ latitude: 35.6812, longitude: 139.7671 }, makeCtx()),
    )

    expect(result.content[0]?.text).toContain('OFFICIAL ALERTS')
    expect(result.content[0]?.text).toContain('```ja')
  })

  it('checks a named alert area without asking the user for coordinates', async () => {
    // No pinned device position: this can pass only if placeName is resolved internally.
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.official_alerts')!

    const result = await Effect.runPromise(
      tool.execute({ placeName: 'Tugaru area' } as never, makeCtx()),
    )
    const text = result.content[0]?.text ?? ''

    expect(text).toContain('Named alert area resolved: 津軽地方, 青森県, 日本 (area)')
    expect(text).toContain('Location: 40.809, 140.380')
    expect(text).toContain('NO DATA covering this location')
    expect(text).not.toMatch(/provide|ask.*latitude|ask.*longitude/i)
  })

  it('executes focus_map and clear_map controls', async () => {
    const focusTool = disasterToolSet.tools.find((t) => t.name === 'disaster.focus_map')!
    await Effect.runPromise(focusTool.execute({ target: 'floods' }, makeCtx()))
    expect(mapAdapter.getFocus()).toBe('floods')

    const clearTool = disasterToolSet.tools.find((t) => t.name === 'disaster.clear_map')!
    await Effect.runPromise(clearTool.execute({}, makeCtx()))
    const allLayers = await Effect.runPromise(mapAdapter.readAllLayers())
    expect(allLayers.length).toBe(0)
  })
})
