import { Effect } from 'effect'
import { Hono } from 'hono'
import { PNG } from 'pngjs'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import { floodModelRoutes } from './flood-model'
import { resetStaticCaches } from '../static-cache'
import { INFRASTRUCTURE_SOURCE_ID } from '../infrastructure-source'
import { LEVEE_SOURCE_ID } from '../levee-source'
import { WATER_SOURCE_ID } from '../water-source'

// Terrain, climatology and embankments are cached per location, so one test's
// stubbed upstream would otherwise answer the next test's question.
beforeEach(() => resetStaticCaches())

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

/**
 * A Terrarium tile carrying a valley: a channel down the middle of the tile
 * falling west to east, with ground rising away from it. Every tile of the
 * mosaic gets the same pattern, which is enough for the network extraction to
 * find a continuous drainage line.
 */
const valleyTile = (): Uint8Array => {
  const png = new PNG({ width: 256, height: 256 })
  for (let row = 0; row < 256; row++) {
    for (let col = 0; col < 256; col++) {
      const distanceFromAxis = Math.abs(row - 128)
      const elevation = Math.round(20 + distanceFromAxis * 2 - col * 0.05)
      const value = elevation + 32768
      const offset = (row * 256 + col) * 4
      png.data[offset] = (value >> 8) & 255
      png.data[offset + 1] = value & 255
      png.data[offset + 2] = 0
      png.data[offset + 3] = 255
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

const flatTile = (elevation: number): Uint8Array => {
  const png = new PNG({ width: 256, height: 256 })
  const value = elevation + 32768
  for (let i = 0; i < 256 * 256; i++) {
    png.data[i * 4] = (value >> 8) & 255
    png.data[i * 4 + 1] = value & 255
    png.data[i * 4 + 2] = 0
    png.data[i * 4 + 3] = 255
  }
  return new Uint8Array(PNG.sync.write(png))
}

interface Upstreams {
  readonly jsonBody?: string
  readonly tileBytes?: Uint8Array
  /** Overpass reply, when a test wants embankments to exist. */
  readonly leveeBody?: string
  readonly waterBody?: string
  readonly infrastructureBody?: string
}

/** One embankment way, as Overpass returns it with `out geom`. */
const overpassEmbankment = (points: Array<[number, number]>) =>
  JSON.stringify({
    elements: [
      {
        type: 'way',
        tags: { man_made: 'dyke' },
        geometry: points.map(([lon, lat]) => ({ lat, lon })),
      },
    ],
  })

/** A lake as Overpass returns a multipolygon relation, boxed around a point. */
const overpassLake = (lon: number, lat: number, halfSpanDeg = 0.01) =>
  JSON.stringify({
    elements: [
      {
        type: 'relation',
        tags: { natural: 'water', water: 'lake' },
        members: [
          {
            type: 'way',
            role: 'outer',
            geometry: [
              { lat: lat - halfSpanDeg, lon: lon - halfSpanDeg },
              { lat: lat - halfSpanDeg, lon: lon + halfSpanDeg },
              { lat: lat + halfSpanDeg, lon: lon + halfSpanDeg },
              { lat: lat + halfSpanDeg, lon: lon - halfSpanDeg },
              { lat: lat - halfSpanDeg, lon: lon - halfSpanDeg },
            ],
          },
        ],
      },
    ],
  })

const overpassInfrastructure = (elements: ReadonlyArray<unknown>) => JSON.stringify({ elements })

const overpassBuilding = (lon: number, lat: number, halfSpanDeg = 0.01) => ({
  type: 'way',
  tags: { building: 'yes' },
  geometry: [
    { lat: lat - halfSpanDeg, lon: lon - halfSpanDeg },
    { lat: lat - halfSpanDeg, lon: lon + halfSpanDeg },
    { lat: lat + halfSpanDeg, lon: lon + halfSpanDeg },
    { lat: lat + halfSpanDeg, lon: lon - halfSpanDeg },
    { lat: lat - halfSpanDeg, lon: lon - halfSpanDeg },
  ],
})

class FakeProxy extends GeoProxyService {
  readonly jsonUrls: Array<string> = []
  readonly sourceIds: Array<string> = []
  readonly tileUrls: Array<string> = []
  private readonly upstreams: Upstreams

  constructor(config: Parameters<typeof floodModelRoutes>[0], upstreams: Upstreams = {}) {
    super(config)
    this.upstreams = upstreams
  }

  /**
   * Levees, standing water and built infrastructure share one upstream, so the
   * stub splits them on source id. Routing all three to one body can make a
   * source assertion pass on geometry meant for another feature.
   */
  override async fetchUpstream(sourceId: string, targetUrl: string) {
    this.jsonUrls.push(targetUrl)
    this.sourceIds.push(sourceId)
    const body =
      sourceId === WATER_SOURCE_ID
        ? this.upstreams.waterBody
        : sourceId === INFRASTRUCTURE_SOURCE_ID
          ? this.upstreams.infrastructureBody
        : targetUrl.includes('overpass-api.de')
          ? this.upstreams.leveeBody
          : this.upstreams.jsonBody
    return {
      status: 200,
      body: body ?? '{}',
      contentType: 'application/json',
      redactedUrl: targetUrl,
    }
  }

  override async fetchUpstreamBinary(_sourceId: string, targetUrl: string) {
    this.tileUrls.push(targetUrl)
    return {
      status: 200,
      bytes: (this.upstreams.tileBytes ?? new Uint8Array(0)) as Uint8Array<ArrayBuffer>,
      contentType: 'image/png',
      redactedUrl: targetUrl,
    }
  }
}

const appWith = (env: Record<string, string | undefined>, upstreams?: Upstreams) => {
  /**
   * Every on-disk store is disabled for every test. They are keyed on location
   * rather than on anything test-specific, so a run with stubbed upstreams would
   * otherwise write synthetic terrain-derived embankments into the same
   * directory a real query reads back — and read a real lake back into a test
   * that stubbed an empty one.
   */
  const config = run(
    loadConfig({ CLIMATE_CACHE_DIR: '', LEVEE_CACHE_DIR: '', WATER_CACHE_DIR: '', ...env }),
  )
  const proxy = new FakeProxy(config, upstreams)
  const app = new Hono()
  app.route('/api/geo', floodModelRoutes(config, proxy))
  return { app, proxy }
}

const model = (app: Hono, body: unknown) =>
  app.request('/api/geo/flood-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

interface ModelResponse {
  ok: boolean
  method: {
    components: Record<string, string>
    channelThresholdKm2: number
    manningN: number
    maxRiverStageM: number
    floodplainManningN: number | null
    compoundMethod: string | null
  }
  runoff: { runoffMm: number }
  network: {
    channelCells: number
    maxDrainageAreaKm2: number
    peakDischargeM3PerS: number
    overtoppingCells: number
    externalCatchmentKm2: number
    externalInflowM3: number
    inlets: Array<{ latitude: number; longitude: number; externalCatchmentKm2: number }>
    dynamics: {
      enabled: boolean
      arrival: null | {
        earliestHours: number
        latestHours: number
        trunkHours: number
        trunkPeakHours: number
      }
      momentum: null | {
        maximumCharacteristicSpeedMPerS: number
        maximumVelocityMPerS: number | null
        maximumFroudeNumber: number | null
        maximumVelocityHeadM: number | null
        affectedReaches: number
      }
      backwater: null | { affectedReaches: number; maximumRiseM: number }
    }
  }
  breaches: Array<{
    cell: number
    widthM: number
    headM: number
    volumeM3: number
    overtopRatio: number
    latitude: number
    longitude: number
  }>
  inundation: {
    maxDepthMetres: number
    floodedAreaKm2: number
    volume: {
      rainfallRunoffM3: number
      stormSewerCapturedM3: number
      surfaceRunoffM3: number
      channelInflowM3: number
      totalIntroducedM3: number
      pondedM3: number
      conveyedByChannelsM3: number
      drainedM3: number
    }
    attribution: {
      pluvialOnlyAreaKm2: number
      fluvialDeltaAreaKm2: number
      pluvialZones?: Array<{ hazardClass: string }>
      fluvialZones?: Array<{ hazardClass: string }>
      fluvialPeggedZones?: Array<{ hazardClass: string }>
    }
    zones: Array<{ hazardClass: string; kind: { kind: string } }>
  }
  provenance: { mode: string; sourceId: string }
  limitations: Array<string>
}

interface ModelInfrastructure {
  status: string
  dams: {
    mappedElements: number
    modelledSites: number
    retainedM3: number
    sites: Array<{ reservoirAreaKm2: number; retainedM3: number }>
  }
  stormSewers: {
    mappedElements: number
    servedGridCells: number
    runoffCapturedM3: number
  }
  buildings: {
    mappedElements: number
    mappedGridCells: number
    depthAdjustedCells: number
    maxDepthMultiplier: number
  }
}

const AT = { latitude: 35.68, longitude: 139.77 }

interface PermanentWater {
  status: string
  retrievedFrom: string
  waterWays: number
  waterRelations: number
  gridCellsWater: number
  gridCellsMasked: number
  areaMaskedKm2: number
}

describe('POST /api/geo/flood-model — validation', () => {
  it('rejects missing or out-of-range coordinates', async () => {
    const { app } = appWith({})
    const missing = await model(app, { radiusKm: 5 })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { fields: Array<{ field: string }> }).fields[0]!.field).toBe('at.latitude')
  })

  it('rejects a radius beyond what the model is built for', async () => {
    const { app } = appWith({})
    const res = await model(app, { at: AT, radiusKm: 25 })
    expect(res.status).toBe(400)
  })

  it('rejects a floodplain roughness outside the physical range', async () => {
    const { app } = appWith({})
    const res = await model(app, { at: AT, radiusKm: 5, floodplainManningN: 0.9 })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { fields: Array<{ field: string }> }).fields[0]!.field).toBe(
      'floodplainManningN',
    )
  })

  it('rejects an unknown DEM source rather than silently using the default', async () => {
    const { app } = appWith({})
    const res = await model(app, { at: AT, radiusKm: 5, demSource: 'srtm' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { fields: Array<{ field: string }> }).fields[0]!.field).toBe(
      'demSource',
    )
  })

  it('rejects a DEM zoom past what the chosen source publishes', async () => {
    const { app } = appWith({})
    // GSI's DEM10B stops at z14; asking for z15 would 404 every tile.
    const res = await model(app, { at: AT, radiusKm: 5, demSource: 'gsi10', demZoom: 15 })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { fields: Array<{ field: string }> }).fields[0]!.field).toBe(
      'demZoom',
    )
  })

  it('rejects out-of-range channel and hydraulic parameters', async () => {
    const { app } = appWith({})
    expect((await model(app, { at: AT, channelThresholdKm2: 0 })).status).toBe(400)
    expect((await model(app, { at: AT, manningN: 0.5 })).status).toBe(400)
    expect((await model(app, { at: AT, leveeBreach: { widthM: 1 } })).status).toBe(400)
    expect((await model(app, { at: AT, leveeBreach: { maxBreaches: 1.5 } })).status).toBe(400)
    expect((await model(app, { at: AT, leveeHeightM: 0.1 })).status).toBe(400)
    expect((await model(app, { at: AT, demBreachMinDepthM: 0 })).status).toBe(400)
    expect((await model(app, { at: AT, channelDefenceMultiple: 0.5 })).status).toBe(400)
    expect((await model(app, { at: AT, damAvailableStorageDepthM: -1 })).status).toBe(400)
    expect((await model(app, { at: AT, stormSewerCapacityMmPerHour: 500 })).status).toBe(400)
    expect((await model(app, { at: AT, stormSewerServiceRadiusM: -1 })).status).toBe(400)
    expect((await model(app, { at: AT, maximumBuildingBlockedFraction: 1 })).status).toBe(400)
    expect((await model(app, { at: AT, useDams: 'yes' })).status).toBe(400)
    expect((await model(app, { at: AT, dynamicRouting: 'yes' })).status).toBe(400)
    expect((await model(app, { at: AT, backwater: 'yes' })).status).toBe(400)
    expect((await model(app, { at: AT, dynamicRouting: false, backwater: true })).status).toBe(400)
  })
})

describe('POST /api/geo/flood-model — fixture mode', () => {
  it('runs the whole coupled pipeline offline and conserves volume', async () => {
    const { app, proxy } = appWith({ GEO_DATA_MODE: 'fixture' })
    const res = await model(app, { at: AT, radiusKm: 2, rainfallMm: 200, curveNumber: 85 })

    expect(res.status).toBe(200)
    const json = (await res.json()) as ModelResponse

    expect(json.ok).toBe(true)
    expect(proxy.jsonUrls).toHaveLength(0)
    expect(proxy.tileUrls).toHaveLength(0)
    expect(json.provenance.sourceId).toBe('estimate.fluvial.coupled')
    expect(json.provenance.mode).toBe('fixture')

    const v = json.inundation.volume
    expect(v.pondedM3 + v.drainedM3).toBeGreaterThan(v.totalIntroducedM3 * 0.999)
    expect(v.pondedM3 + v.drainedM3).toBeLessThan(v.totalIntroducedM3 * 1.001)
    expect(json.inundation.floodedAreaKm2).toBeGreaterThan(0)
    expect(json.inundation.zones.length).toBeGreaterThan(0)
    for (const zone of json.inundation.zones) expect(zone.kind.kind).toBe('scenario')

    // Every process the endpoint claims to model is named in the method block.
    for (const key of [
      'pluvial',
      'network',
      'routing',
      'momentum',
      'backwater',
      'channel',
      'channelInflow',
      'leveeBreach',
      'dams',
      'stormDrainage',
      'buildings',
      'spreading',
    ]) {
      expect(json.method.components[key]).toBeTruthy()
    }
    expect(json.limitations.length).toBeGreaterThan(0)
  })

  it('reports the pluvial baseline alongside the coupled result', async () => {
    const { app } = appWith({ GEO_DATA_MODE: 'fixture' })
    const json = (await (await model(app, { at: AT, radiusKm: 2, rainfallMm: 200 })).json()) as ModelResponse
    expect(json.inundation.attribution.pluvialOnlyAreaKm2).toBeGreaterThan(0)
    expect(json.inundation.attribution.fluvialDeltaAreaKm2).toBeCloseTo(
      json.inundation.floodedAreaKm2 - json.inundation.attribution.pluvialOnlyAreaKm2,
      3,
    )
  })

  it('draws each mechanism as its own extent only when asked', async () => {
    const body = { at: AT, radiusKm: 2, rainfallMm: 200 }

    const { app: quiet } = appWith({ GEO_DATA_MODE: 'fixture' })
    const without = (await (await model(quiet, body)).json()) as ModelResponse
    expect(without.inundation.attribution.pluvialZones).toBeUndefined()
    expect(without.inundation.attribution.fluvialZones).toBeUndefined()
    expect(without.inundation.attribution.fluvialPeggedZones).toBeUndefined()

    const { app } = appWith({ GEO_DATA_MODE: 'fixture' })
    const json = (await (
      await model(app, { ...body, componentZones: true })
    ).json()) as ModelResponse
    // The pluvial field has area here, so it must have shape too; the fluvial
    // one may legitimately be empty on terrain with no channel worth the name.
    expect(json.inundation.attribution.pluvialOnlyAreaKm2).toBeGreaterThan(0)
    expect(json.inundation.attribution.pluvialZones!.length).toBeGreaterThan(0)
    expect(json.inundation.attribution.fluvialZones).toBeDefined()
    // Pegged water is a subset of the fluvial field, so the shape must exist
    // whenever the components were asked for, even if it is empty here.
    expect(json.inundation.attribution.fluvialPeggedZones).toBeDefined()
  })
})

describe('POST /api/geo/flood-model — live mode', () => {
  const live = { GEO_DATA_MODE: 'live' }
  const rain = JSON.stringify(Array.from({ length: 5 }, () => ({ hourly: { precipitation: [30, 30] } })))

  it('extracts a channel network and routes discharge down it', async () => {
    const { app, proxy } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const res = await model(app, {
      at: AT,
      radiusKm: 3,
      durationHours: 2,
      rainfallMm: 300,
      channelThresholdKm2: 0.5,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as ModelResponse

    expect(proxy.tileUrls[0]).toContain('s3.amazonaws.com/elevation-tiles-prod/terrarium/')
    expect(json.network.channelCells).toBeGreaterThan(0)
    expect(json.network.maxDrainageAreaKm2).toBeGreaterThan(0.5)
    expect(json.network.peakDischargeM3PerS).toBeGreaterThan(0)
    expect(json.network.dynamics.enabled).toBe(true)
    expect(json.network.dynamics.arrival).not.toBeNull()
    expect(json.network.dynamics.arrival!.trunkHours).toBeGreaterThan(0)
    expect(json.network.dynamics.arrival!.trunkPeakHours).toBeGreaterThan(
      json.network.dynamics.arrival!.trunkHours,
    )
    expect(json.network.dynamics.momentum).not.toBeNull()
    expect(json.network.dynamics.momentum!.maximumCharacteristicSpeedMPerS).toBeGreaterThan(0)
    expect(json.network.dynamics.backwater).toBeNull()
    expect(json.method.components.backwater).toContain('disabled')
    // Water the channels carry is water that did not have to pond.
    expect(json.inundation.volume.conveyedByChannelsM3).toBeGreaterThan(0)
  })

  it('applies and reports standard-step backwater only when explicitly requested', async () => {
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const json = (await (
      await model(app, {
        at: AT,
        radiusKm: 3,
        durationHours: 2,
        rainfallMm: 300,
        channelThresholdKm2: 0.5,
        backwater: true,
      })
    ).json()) as ModelResponse

    expect(json.network.dynamics.enabled).toBe(true)
    expect(json.network.dynamics.backwater).not.toBeNull()
    expect(json.network.dynamics.backwater!.affectedReaches).toBeGreaterThanOrEqual(0)
    expect(json.network.dynamics.backwater!.maximumRiseM).toBeGreaterThanOrEqual(0)
    expect(json.network.dynamics.momentum!.maximumVelocityMPerS).not.toBeNull()
  })

  it('can reproduce the legacy event-average independent-reach routing', async () => {
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const json = (await (
      await model(app, {
        at: AT,
        radiusKm: 3,
        durationHours: 2,
        rainfallMm: 300,
        channelThresholdKm2: 0.5,
        dynamicRouting: false,
      })
    ).json()) as ModelResponse

    expect(json.network.dynamics.enabled).toBe(false)
    expect(json.network.dynamics.arrival).toBeNull()
    expect(json.network.dynamics.momentum).toBeNull()
    expect(json.network.dynamics.backwater).toBeNull()
    expect(json.method.components.momentum).toContain('disabled')
    expect(json.method.components.backwater).toContain('disabled')
  })

  it('injects upstream catchment inflow at the inlets it finds, and can be told not to', async () => {
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const withInflow = (await (
      await model(app, { at: AT, radiusKm: 3, rainfallMm: 300, channelThresholdKm2: 0.5 })
    ).json()) as ModelResponse

    const { app: app2 } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const without = (await (
      await model(app2, { at: AT, radiusKm: 3, rainfallMm: 300, channelThresholdKm2: 0.5, channelInflow: false })
    ).json()) as ModelResponse

    expect(without.network.externalInflowM3).toBe(0)
    expect(without.network.inlets).toHaveLength(0)
    expect(withInflow.network.externalInflowM3).toBeGreaterThan(0)
    expect(withInflow.network.externalCatchmentKm2).toBeGreaterThan(0)
    expect(withInflow.inundation.volume.channelInflowM3).toBe(withInflow.network.externalInflowM3)
    // The extra water has to show up in the budget, and it is not rain.
    expect(withInflow.inundation.volume.totalIntroducedM3).toBeGreaterThan(
      without.inundation.volume.totalIntroducedM3,
    )
    expect(withInflow.inundation.volume.rainfallRunoffM3).toBeCloseTo(
      without.inundation.volume.rainfallRunoffM3,
      -1,
    )
  })

  it('breaching a levee floods more than leaving it intact', async () => {
    const body = { at: AT, radiusKm: 3, rainfallMm: 800, durationHours: 6, channelThresholdKm2: 0.5 }

    const { app: breached } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const withBreach = (await (
      await model(breached, { ...body, leveeBreach: { enabled: true, widthM: 200, maxBreaches: 3 } })
    ).json()) as ModelResponse

    const { app: intact } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const noBreach = (await (
      await model(intact, { ...body, leveeBreach: { enabled: false } })
    ).json()) as ModelResponse

    expect(noBreach.breaches).toHaveLength(0)
    expect(withBreach.breaches.length).toBeGreaterThan(0)
    for (const b of withBreach.breaches) {
      expect(b.overtopRatio).toBeGreaterThan(1)
      expect(b.headM).toBeGreaterThan(0)
      expect(b.volumeM3).toBeGreaterThan(0)
      expect(b.widthM).toBe(200)
      // A breach is only useful if it can be put on a map.
      expect(Math.abs(b.latitude - AT.latitude)).toBeLessThan(1)
      expect(Math.abs(b.longitude - AT.longitude)).toBeLessThan(1)
    }
    // Losing channel conveyance at the breach leaves more water on the ground.
    expect(withBreach.inundation.volume.pondedM3).toBeGreaterThanOrEqual(
      noBreach.inundation.volume.pondedM3,
    )
    expect(withBreach.inundation.volume.conveyedByChannelsM3).toBeLessThanOrEqual(
      noBreach.inundation.volume.conveyedByChannelsM3,
    )
  })

  it('solves a compound section by default, and collapses to one on request', async () => {
    const body = { at: AT, radiusKm: 3, rainfallMm: 300, durationHours: 2, channelThresholdKm2: 0.5 }

    const { app: standard } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const compound = (await (await model(standard, body)).json()) as ModelResponse
    expect(compound.method.floodplainManningN).toBe(0.1)
    expect(compound.method.compoundMethod).toBe('composite')

    // Setting the floodplain to the channel's own roughness is how every figure
    // recorded before round eight is reproduced, so it has to give back exactly
    // the single-section curve rather than merely something close to it.
    const { app: plain } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const single = (await (
      await model(plain, { ...body, floodplainManningN: compound.method.manningN })
    ).json()) as ModelResponse
    expect(single.method.floodplainManningN).toBe(single.method.manningN)

    // A rougher floodplain conveys less, so the rating curve has to stand the
    // river higher to pass the same flow, and more ground ends up under it.
    expect(compound.inundation.floodedAreaKm2).toBeGreaterThan(single.inundation.floodedAreaKm2)
  })

  it('stands every river at one height when asked, and floods more as it rises', async () => {
    const body = { at: AT, radiusKm: 3, rainfallMm: 300, durationHours: 2, channelThresholdKm2: 0.5 }

    const { app: low } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const shallow = (await (await model(low, { ...body, uniformStageM: 1 })).json()) as ModelResponse

    const { app: high } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const deep = (await (await model(high, { ...body, uniformStageM: 6 })).json()) as ModelResponse

    // The rating curve is bypassed, so the reported stage is exactly what was
    // asked for rather than whatever the discharge implies.
    expect(shallow.method.maxRiverStageM).toBe(1)
    expect(deep.method.maxRiverStageM).toBe(6)
    expect(deep.inundation.floodedAreaKm2).toBeGreaterThan(shallow.inundation.floodedAreaKm2)
  })

  it('fetches embankments, burns them onto the grid, and reports what it used', async () => {
    // A dyke straight across the valley just south of the query point.
    const levee = overpassEmbankment([
      [AT.longitude - 0.05, AT.latitude - 0.01],
      [AT.longitude + 0.05, AT.latitude - 0.01],
    ])
    const { app, proxy } = appWith(live, { jsonBody: rain, tileBytes: valleyTile(), leveeBody: levee })
    const res = await model(app, { at: AT, radiusKm: 3, rainfallMm: 300, channelInflow: false })
    expect(res.status).toBe(200)
    const json = (await res.json()) as ModelResponse & {
      defences: { status: string; embankmentWays: number; gridCellsWithEmbankment: number }
    }

    expect(proxy.jsonUrls.some((u) => u.includes('overpass-api.de'))).toBe(true)
    expect(json.defences.status).toBe('ok')
    expect(json.defences.embankmentWays).toBe(1)
    expect(json.defences.gridCellsWithEmbankment).toBeGreaterThan(0)
  })

  it('removes only finite runoff volume near a mapped storm-drain network', async () => {
    const infrastructureBody = overpassInfrastructure([
      { type: 'node', tags: { man_made: 'storm_drain' }, lon: AT.longitude, lat: AT.latitude },
    ])
    const common = {
      at: AT,
      radiusKm: 2,
      rainfallMm: 300,
      durationHours: 2,
      channelInflow: false,
      useLevees: false,
      maskPermanentWater: false,
      useDams: false,
      useBuildings: false,
      stormSewerCapacityMmPerHour: 200,
      stormSewerServiceRadiusM: 1000,
    }
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile(), infrastructureBody })
    const drained = (await (await model(app, common)).json()) as ModelResponse & {
      infrastructure: ModelInfrastructure
    }

    const { app: appOff } = appWith(live, { jsonBody: rain, tileBytes: valleyTile(), infrastructureBody })
    const undrained = (await (
      await model(appOff, { ...common, useStormSewers: false })
    ).json()) as ModelResponse

    expect(drained.infrastructure.stormSewers.mappedElements).toBe(1)
    expect(drained.infrastructure.stormSewers.servedGridCells).toBeGreaterThan(1)
    expect(drained.infrastructure.stormSewers.runoffCapturedM3).toBeGreaterThan(0)
    expect(drained.inundation.volume.stormSewerCapturedM3).toBe(
      drained.infrastructure.stormSewers.runoffCapturedM3,
    )
    expect(drained.inundation.volume.totalIntroducedM3).toBeLessThan(
      undrained.inundation.volume.totalIntroducedM3,
    )
    expect(
      drained.inundation.volume.surfaceRunoffM3 + drained.inundation.volume.stormSewerCapturedM3,
    ).toBeCloseTo(drained.inundation.volume.rainfallRunoffM3, -1)
  })

  it('uses mapped building footprint as displaced sub-grid flood storage', async () => {
    const infrastructureBody = overpassInfrastructure([
      overpassBuilding(AT.longitude, AT.latitude, 0.015),
    ])
    const common = {
      at: AT,
      radiusKm: 2,
      rainfallMm: 300,
      channelInflow: false,
      useLevees: false,
      maskPermanentWater: false,
      useDams: false,
      useStormSewers: false,
    }
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile(), infrastructureBody })
    const structured = (await (await model(app, common)).json()) as ModelResponse & {
      infrastructure: ModelInfrastructure
    }

    const { app: appOff } = appWith(live, { jsonBody: rain, tileBytes: valleyTile(), infrastructureBody })
    const openGround = (await (
      await model(appOff, { ...common, useBuildings: false })
    ).json()) as ModelResponse

    expect(structured.infrastructure.buildings.mappedElements).toBe(1)
    expect(structured.infrastructure.buildings.mappedGridCells).toBeGreaterThan(0)
    expect(structured.infrastructure.buildings.depthAdjustedCells).toBeGreaterThan(0)
    expect(structured.infrastructure.buildings.maxDepthMultiplier).toBeGreaterThan(1)
    expect(structured.inundation.maxDepthMetres).toBeGreaterThan(openGround.inundation.maxDepthMetres)
  })

  it('routes event volume through finite storage at a mapped dam', async () => {
    const infrastructureBody = overpassInfrastructure([
      { type: 'node', tags: { waterway: 'dam' }, lon: AT.longitude, lat: AT.latitude },
    ])
    const upstreams = {
      jsonBody: rain,
      tileBytes: valleyTile(),
      infrastructureBody,
      // The west side of the east-falling test valley is upstream of the dam.
      waterBody: overpassLake(AT.longitude - 0.012, AT.latitude, 0.012),
    }
    const { app } = appWith(live, upstreams)
    const json = (await (
      await model(app, {
        at: AT,
        radiusKm: 2,
        rainfallMm: 300,
        channelInflow: false,
        useLevees: false,
        maskPermanentWater: false,
        useStormSewers: false,
        useBuildings: false,
        damAvailableStorageDepthM: 5,
      })
    ).json()) as ModelResponse & { infrastructure: ModelInfrastructure }

    expect(json.infrastructure.dams.mappedElements).toBe(1)
    expect(json.infrastructure.dams.modelledSites).toBe(1)
    expect(json.infrastructure.dams.sites[0]!.reservoirAreaKm2).toBeGreaterThan(0)
    expect(json.infrastructure.dams.retainedM3).toBeGreaterThan(0)
  })

  it('does not call Overpass when every mapped refinement is turned off', async () => {
    const { app, proxy } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const res = await model(app, {
      at: AT, radiusKm: 2, rainfallMm: 200, useLevees: false, maskPermanentWater: false,
      useDams: false, useStormSewers: false, useBuildings: false,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as ModelResponse & { defences: { status: string } }
    expect(proxy.jsonUrls.some((u) => u.includes('overpass-api.de'))).toBe(false)
    expect(json.defences.status).toContain('disabled')
  })

  it('does not ask for embankments when only defences are turned off', async () => {
    const { app, proxy } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const res = await model(app, { at: AT, radiusKm: 2, rainfallMm: 200, useLevees: false })
    expect(res.status).toBe(200)
    expect(proxy.sourceIds).not.toContain(LEVEE_SOURCE_ID)
    expect(proxy.sourceIds).toContain(WATER_SOURCE_ID)
  })

  it('leaves a mapped lake out of the reported extent', async () => {
    const upstreams = {
      jsonBody: rain,
      tileBytes: valleyTile(),
      waterBody: overpassLake(AT.longitude, AT.latitude),
    }
    const { app } = appWith(live, upstreams)
    const masked = (await (
      await model(app, { at: AT, radiusKm: 2, rainfallMm: 200 })
    ).json()) as ModelResponse & { permanentWater: PermanentWater }

    const { app: appOff } = appWith(live, upstreams)
    const unmasked = (await (
      await model(appOff, { at: AT, radiusKm: 2, rainfallMm: 200, maskPermanentWater: false })
    ).json()) as ModelResponse & { permanentWater: PermanentWater }

    expect(masked.permanentWater.status).toBe('ok')
    expect(masked.permanentWater.waterRelations).toBe(1)
    expect(masked.permanentWater.gridCellsWater).toBeGreaterThan(0)
    expect(masked.permanentWater.gridCellsMasked).toBeGreaterThan(0)
    expect(masked.permanentWater.areaMaskedKm2).toBeGreaterThan(0)
    // The lake sat inside the flooded valley, so the extent has to shrink.
    expect(masked.inundation.floodedAreaKm2).toBeLessThan(unmasked.inundation.floodedAreaKm2)
    expect(unmasked.permanentWater.status).toContain('disabled')
    expect(unmasked.permanentWater.gridCellsMasked).toBe(0)
  })

  it('keeps the whole extent when Overpass cannot be read, and says so', async () => {
    // The safe direction: losing the water map restores the older, more
    // generous answer rather than failing the request or quietly trimming it.
    const upstreams = { jsonBody: rain, tileBytes: valleyTile(), waterBody: 'not json' }
    const { app } = appWith(live, upstreams)
    const degraded = (await (
      await model(app, { at: AT, radiusKm: 2, rainfallMm: 200 })
    ).json()) as ModelResponse & { permanentWater: PermanentWater }

    const { app: appOff } = appWith(live, upstreams)
    const off = (await (
      await model(appOff, { at: AT, radiusKm: 2, rainfallMm: 200, maskPermanentWater: false })
    ).json()) as ModelResponse

    expect(degraded.permanentWater.status).toContain('unreadable')
    expect(degraded.permanentWater.retrievedFrom).toBe('none')
    expect(degraded.permanentWater.gridCellsMasked).toBe(0)
    expect(degraded.inundation.floodedAreaKm2).toBe(off.inundation.floodedAreaKm2)
  })

  it('rejects a non-boolean water mask flag', async () => {
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile() })
    const res = await model(app, { at: AT, radiusKm: 2, maskPermanentWater: 'yes' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { fields: Array<{ field: string }> }).fields[0]!.field).toBe(
      'maskPermanentWater',
    )
  })

  it('carries on with no defences when Overpass is unreadable', async () => {
    const { app } = appWith(live, { jsonBody: rain, tileBytes: valleyTile(), leveeBody: 'not json' })
    const res = await model(app, { at: AT, radiusKm: 2, rainfallMm: 200 })
    expect(res.status).toBe(200)
    const json = (await res.json()) as ModelResponse & { defences: { status: string; embankmentWays: number } }
    expect(json.defences.embankmentWays).toBe(0)
    expect(json.defences.status).toContain('unreadable')
  })

  it('finds no channels on a featureless plain, and floods nothing there', async () => {
    const { app } = appWith(live, { jsonBody: rain, tileBytes: flatTile(50) })
    const json = (await (
      await model(app, { at: AT, radiusKm: 2, rainfallMm: 5, channelInflow: false })
    ).json()) as ModelResponse
    expect(json.inundation.floodedAreaKm2).toBe(0)
    expect(json.breaches).toHaveLength(0)
  })

  it('serves a repeat of the same question from cache', async () => {
    const { app } = appWith(live, {
      jsonBody: rain,
      tileBytes: valleyTile(),
      infrastructureBody: overpassInfrastructure([]),
    })
    const body = { at: AT, radiusKm: 2, rainfallMm: 150, channelInflow: false }

    const first = await model(app, body)
    expect(first.headers.get('x-cache-hit')).toBe('false')
    const second = await model(app, body)
    expect(second.headers.get('x-cache-hit')).toBe('true')
    expect(await second.text()).toBe(await first.text())
  })

  it('does not cache a response with a degraded infrastructure layer', async () => {
    const { app } = appWith(live, {
      jsonBody: rain,
      tileBytes: valleyTile(),
      infrastructureBody: 'not json',
    })
    const body = { at: AT, radiusKm: 2, rainfallMm: 150, channelInflow: false }

    const first = await model(app, body)
    const second = await model(app, body)

    expect(first.headers.get('x-cache-hit')).toBe('false')
    expect(second.headers.get('x-cache-hit')).toBe('false')
  })

  it('answers 502 with advice when the precipitation feed is unreadable', async () => {
    const { app } = appWith(live, { jsonBody: 'not json', tileBytes: valleyTile() })
    const res = await model(app, { at: AT, radiusKm: 2 })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { message: string }).message).toContain('rainfallMm')
  })
})
