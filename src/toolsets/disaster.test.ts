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
import type { ToolContext } from '../domain/tool'
import { newCallId, newTurnId } from '../domain/ids'

const makeCtx = (): ToolContext => ({
  signal: new AbortController().signal,
  callId: newCallId(),
  turnId: newTurnId(),
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

  it('declares 7 tools with flat schemas and honest annotations (8.1, 8.2)', () => {
    expect(disasterToolSet.tools.length).toBe(7)
    const names = disasterToolSet.tools.map((t) => t.name)
    expect(names).toEqual([
      'disaster.locate',
      'disaster.flood_forecast',
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

    const layer = await Effect.runPromise(mapAdapter.readLayer('routes'))
    expect(layer).toBeDefined()
    expect(layer?.featureCount).toBe(2)
  })

  it('executes disaster.official_alerts with fenced output', async () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.official_alerts')!
    const result = await Effect.runPromise(
      tool.execute({ latitude: 35.6812, longitude: 139.7671 }, makeCtx()),
    )

    expect(result.content[0]?.text).toContain('OFFICIAL ALERTS')
    expect(result.content[0]?.text).toContain('```ja')
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
