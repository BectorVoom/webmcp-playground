import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { LonLat } from '../../src/domain/geo'
import type { Provenance } from '../../src/domain/provenance'
import { clipAndMergeZones } from '../../src/lib/geometry/clip'
import { rasterTilesToFloodZones } from '../../src/lib/geometry/contour'
import { INUNDATION_BANDS, depthsToClassifiedTiles, summariseDepthsInCircle } from '../../src/lib/hydrology/bands'
import { planBreaches, DEFAULT_BREACH_WIDTH_M, type BreachSite } from '../../src/lib/hydrology/breach'
import {
  arealReductionFactor,
  deliverableInflow,
  mainChannelLengthKm,
  meanAnnualFloodM3PerS,
} from '../../src/lib/hydrology/catchment'
import {
  DEFAULT_CHANNEL_THRESHOLD_KM2,
  DEFAULT_MANNING_N,
  FLOODPLAIN_MANNING_N,
  assessDischargeOvertopping,
  channelGeometry,
  conveyanceVolumeM3,
} from '../../src/lib/hydrology/channel'
import { estimateFloodWave } from '../../src/lib/hydrology/dynamics'
import {
  breachSpuriousDepressions,
  channelMask,
  d8Receivers,
  downstreamSlope,
  findInlets,
  flowAccumulate,
  flowAccumulateMax,
  priorityFlood,
} from '../../src/lib/hydrology/flow'
import {
  DEFAULT_CURVE_NUMBER,
  MAX_CURVE_NUMBER,
  MIN_CURVE_NUMBER,
  estimateRunoff,
} from '../../src/lib/hydrology/runoff'
import {
  combineDepths,
  fluvialInundation,
  heightAboveDrainage,
  type CompoundMethod,
  type StageDischarge,
} from '../../src/lib/hydrology/fluvial'
import {
  DEFAULT_LEVEE_HEIGHT_M,
  applyLeveeProtection,
  openBreaches,
  rasteriseLevees,
} from '../../src/lib/hydrology/levee'
import {
  applyBuildingStorageDisplacement,
  applyStormDrainage,
  rasteriseInfrastructure,
  routeThroughDams,
} from '../../src/lib/hydrology/infrastructure'
import { spreadRunoff } from '../../src/lib/hydrology/spread'
import { maskPermanentWater, rasteriseWaterBodies } from '../../src/lib/hydrology/water'
import {
  TILE_SIZE,
  columnLongitude,
  mosaicGeometry,
  type ElevationMosaic,
  type MosaicGeometry,
} from '../../src/lib/hydrology/terrain'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../env'
import {
  DEFAULT_DURATION_HOURS,
  DEFAULT_RADIUS_KM,
  DEM_SOURCES,
  MAX_DESIGN_STORM_MM,
  MAX_DURATION_HOURS,
  MAX_RADIUS_KM,
  PrecipitationUnavailable,
  badRequest,
  chooseDemZoom,
  isDemSource,
  loadTerrain,
  numberInRange,
  type DemSource,
  resolvePrecipitation,
} from '../flood-inputs'
import { GeoProxyService } from '../geo-proxy'
import { CLIMATE_ATTRIBUTION, CLIMATE_SOURCE_ID, loadRainfallClimatology } from '../climate-source'
import {
  INFRASTRUCTURE_ATTRIBUTION,
  INFRASTRUCTURE_SOURCE_ID,
  loadInfrastructure,
} from '../infrastructure-source'
import { LEVEE_ATTRIBUTION, LEVEE_SOURCE_ID, loadLevees } from '../levee-source'
import { WATER_ATTRIBUTION, WATER_SOURCE_ID, loadWater } from '../water-source'
import { upstreamErrorStatus } from './geo'

/**
 * POST /api/geo/flood-model
 *
 * A coupled pluvial-fluvial screening model. Where
 * `/api/geo/inundation-estimate` ponds rain where it falls, this endpoint also
 * builds the drainage network, routes water through it, and applies mapped
 * infrastructure at sub-grid scale, so it can represent the processes that
 * dominate real surface-water and river flooding:
 *
 *   - **River routing** — D8 flow directions and contributing area over the
 *     priority-flood filled DEM give a channel network; runoff is accumulated
 *     downstream along it to a steady-state discharge per reach.
 *   - **Channel inflow** — a query window is not a catchment. A coarse
 *     regional analysis over a wider context finds where rivers cross into the
 *     window and how much land drains to that crossing, and injects the
 *     upstream catchment's runoff there. For a city on a large river this is
 *     usually the dominant term, and omitting it is why a window-limited model
 *     under-predicts.
 *   - **Levee breach** — reaches carrying more than their bankfull capacity are
 *     breach candidates; a breach is a broad-crested weir in the embankment
 *     that diverts flow out of the channel onto the floodplain, represented in
 *     the spreading step as a local loss of channel conveyance.
 *   - **Built infrastructure** — mapped dams retain finite reservoir storage,
 *     storm drains remove finite local runoff, and building footprint displaces
 *     storage within a coarse DEM cell.
 *
 * Channel conveyance is what ties them together. In the spreading step a
 * depression may pass water downstream up to the capacity of the largest
 * channel running through it, and floods only with what the channel cannot
 * carry — which is the difference between "this valley has a river in it" and
 * "this valley is a bathtub".
 *
 * It remains a screening model, but the river arm is no longer timeless:
 * routed event volume is converted to a timed hydrograph peak, shallow-water
 * characteristic speed carries momentum into travel time, and a standard-step
 * energy balance propagates subcritical backwater upstream. The returned map is
 * still the maximum envelope over the event, not a frame-by-frame forecast.
 */

interface BreachOptions {
  readonly enabled?: boolean
  readonly widthM?: number
  readonly maxBreaches?: number
}

interface FloodModelRequestBody {
  readonly at?: { readonly latitude?: number; readonly longitude?: number }
  readonly radiusKm?: number
  readonly rainfallMm?: number
  readonly durationHours?: number
  readonly curveNumber?: number
  /**
   * Use event hydrograph timing plus momentum/backwater stage controls. Default
   * true. False reproduces the former event-average, independent-reach solve.
   */
  readonly dynamicRouting?: boolean
  /**
   * Propagate downstream water-surface controls upstream with the standard-step
   * energy equation. Default false: the hindcast shows the coarse synthetic
   * sections over-expand the envelope; retained for controlled evaluation.
   */
  readonly backwater?: boolean
  /** Contributing area at which a hillslope is treated as a channel, km². */
  readonly channelThresholdKm2?: number
  /** Manning's n for channel conveyance. */
  readonly manningN?: number
  /**
   * Manning's n for the floodplain, which switches the fluvial rating curve to
   * a compound section: the channel carries what `manningN` allows and the
   * floodplain around it what this allows.
   *
   * Running one roughness across the whole flooded width makes the floodplain
   * as smooth as a clean stream, so it conveys too much and the curve settles
   * at too low a stage. Defaults to `FLOODPLAIN_MANNING_N`; set it equal to
   * `manningN` for the single-section curve every figure before round eight was
   * measured with, which the composite blend reproduces exactly.
   */
  readonly floodplainManningN?: number
  /**
   * How the two roughnesses are combined once `floodplainManningN` is set:
   * `composite` blends them over the wetted perimeter, `divided` gives each
   * sub-section its own conveyance and sums them. Default `composite`.
   */
  readonly compoundMethod?: CompoundMethod
  /**
   * How many times bankfull discharge each reach is defended to. Bankfull is
   * roughly a one-to-two-year flow, so an undefended value of 1 has every
   * managed river inundating its floodplain in any real storm. Calibrated
   * default; set 1 to assume no flood defences anywhere.
   */
  readonly channelDefenceMultiple?: number
  /** Use mapped embankments as barriers to river inundation. Default true. */
  readonly useLevees?: boolean
  /** Crest height of an embankment above local ground, metres. */
  readonly leveeHeightM?: number
  /**
   * Depth below which a closed depression is left alone rather than carved
   * open. On a flat plain most shallow basins in a 60 m DEM are artifacts —
   * road embankments, quantisation, unresolved culverts — so a lower value
   * removes more spurious ponding, at the risk of draining real backswamps.
   */
  readonly demBreachMinDepthM?: number
  /**
   * Which discharge the river's stage is solved for. `excess` spreads only what
   * exceeds the defended capacity, so extent grows continuously as defences are
   * passed; `total` puts the whole flow on the floodplain the moment they fail.
   *
   * Defaults to `total`, which is what every published figure for this model
   * was measured with. `excess` is the more physical reading and is expected to
   * become the default, but not before it has been scored against the four
   * hindcast events — see docs/specs/flood-model/plan-stage-reconciliation.md.
   */
  readonly stageDischarge?: StageDischarge
  /**
   * Hold floodplain storage upstream of a point to the overbank volume
   * delivered past it, instead of mapping the rating-curve stage with no check
   * that the water to fill it exists. Default false, pending the same
   * measurement; the budget it evaluates is reported either way.
   */
  readonly volumeConstraint?: boolean
  /**
   * Reduce the point rainfall to a catchment average before it sets bankfull
   * capacity. Leaving it off overstates capacity on a large catchment and so
   * understates flooding, which is the unsafe direction; default false only
   * until the change has been measured.
   */
  readonly arealReduction?: boolean
  /** Include upstream catchment inflow at domain inlets. Default true. */
  readonly channelInflow?: boolean
  /**
   * Also vectorise the pluvial and fluvial fields on their own, so an error can
   * be attributed to the mechanism that produced it. `attribution` already
   * reports each part's area; without its shape there is no way to ask which
   * mechanism owns a particular wrong cell, which is the question accuracy work
   * keeps needing. Off by default: it costs two extra vectorisation passes, and
   * vectorising is the most expensive stage of the request.
   */
  readonly componentZones?: boolean
  /**
   * Event rainfall over the upstream catchment, mm. A fluvial disaster is
   * usually driven by rain that fell somewhere other than the flooded town, so
   * this may legitimately differ from `rainfallMm`. Defaults to `rainfallMm`.
   */
  readonly upstreamRainfallMm?: number
  readonly leveeBreach?: BreachOptions
  /**
   * Diagnostic: stand every river at this height above its bed and skip the
   * rating curve. Sweeping it measures the best extent HAND on this terrain
   * could give if the stage were chosen perfectly — the ceiling the rating
   * curve is working under. Not a modelling option.
   */
  readonly uniformStageM?: number
  /**
   * Window over which the solved stage is averaged along the channel, metres.
   * Each reach solves its rating curve from only the strip of cells that drain
   * to it, so adjacent reaches on one river can stand metres apart — noise a
   * real water surface does not have. 0 (the default) disables; see
   * `FluvialInput.stageSmoothingM` for what it does to pegged reaches.
   */
  readonly stageSmoothingM?: number
  /**
   * Exclude mapped lakes, reservoirs and river channels from the reported
   * extent. Default true.
   *
   * The model reads terrain, not water, so both of its mechanisms are drawn to
   * standing water: a lake basin is a closed depression that ponds rain and
   * never drains, and it carries the drainage network so the river stage covers
   * it too. Reporting it is not a warning — the water is already there — and it
   * was 15 to 33% of the false-positive area at every hindcast site.
   *
   * Set false to reproduce any figure recorded before this existed. An Overpass
   * outage has the same effect and says so in `permanentWater.status`.
   */
  readonly maskPermanentWater?: boolean
  /**
   * Attenuate routed event volume at mapped dams by the available storage in
   * their mapped upstream reservoir. Default true.
   */
  readonly useDams?: boolean
  /**
   * Assumed reservoir drawdown available at the start of the event, metres.
   * Multiplied by mapped normal-pool area; default 0.5 m.
   */
  readonly damAvailableStorageDepthM?: number
  /** Remove finite-capacity surface runoff near mapped storm drains and sewers. */
  readonly useStormSewers?: boolean
  /** Event-average inlet/network capacity over served cells, mm/h. Default 15. */
  readonly stormSewerCapacityMmPerHour?: number
  /** Ground distance around mapped drainage geometry treated as served. Default 100 m. */
  readonly stormSewerServiceRadiusM?: number
  /** Account for mapped building footprints as displaced flood storage. */
  readonly useBuildings?: boolean
  /** Highest building share allowed to amplify a cell's open-area depth. Default 0.8. */
  readonly maximumBuildingBlockedFraction?: number
  /**
   * Which elevation tileset to read the terrain from. Defaults to `terrarium`,
   * the global SRTM-derived set, which is the only one with worldwide coverage.
   * `gsi10` and `gsi5` are Japan's national survey and are far more accurate
   * where they apply — see `DEM_SOURCES`.
   */
  readonly demSource?: DemSource
  /**
   * Zoom to read the DEM at, before the grid budget is applied. Higher is finer;
   * the budget still degrades it until the circle fits, so this raises the
   * ceiling rather than forcing a resolution. Defaults to the source's own
   * `startZoom`.
   */
  readonly demZoom?: number
}

const MAX_INLETS_REPORTED = 10
const BREACH_INFLUENCE_CELLS = 3
const DEFAULT_MAX_BREACHES = 3
/** Two breaches closer than this are the same failure counted twice. */
const MIN_BREACH_SEPARATION_M = 3000
/** Coarse regional pass: wide enough to see the upstream catchment, cheap enough to run. */
const CONTEXT_RADIUS_MULTIPLE = 3
const MAX_CONTEXT_RADIUS_KM = 60
const CONTEXT_START_ZOOM = 10
/**
 * Reach length over which channel slope is measured. A single cell's drop on a
 * DEM quantised to the metre is mostly quantisation, and Manning takes its
 * square root; 2 km of river averages that out without flattening real grade.
 */
const SLOPE_REACH_METRES = 2000
/**
 * Bankfull multiple a reach is assumed to be defended to, calibrated against
 * five Japanese flood disasters (see docs/specs/flood-model/design.md). Not
 * derived from anything — it stands in for levee data the DEM does not carry.
 */
const DEFAULT_CHANNEL_DEFENCE_MULTIPLE = 1
/**
 * Accumulation the rainfall climatology's return levels are computed over. The
 * archive is a daily series, and the areal reduction factor is a function of
 * storm duration, so it has to be the same 24 h `meanAnnualFloodM3PerS` assumes.
 */
const CLIMATOLOGY_ACCUMULATION_HOURS = 24
/**
 * Stage reconciliation and areal reduction, all three off by default.
 *
 * Each is implemented, unit-tested, and believed to be the more correct
 * formulation; none has yet been scored against the four hindcast events,
 * because the ERA5 climatology they all depend on is behind a daily request
 * cap that was exhausted before the run could be made. Two of the three reduce
 * the mapped extent, which is the unsafe direction for a life-safety tool, and
 * this model's own history is that changes which looked obviously right
 * repeatedly did nothing. So the shipped defaults stay exactly where the last
 * measured result left them until the measurement exists.
 *
 * See docs/specs/flood-model/plan-stage-reconciliation.md §8.
 */
const DEFAULT_STAGE_DISCHARGE: StageDischarge = 'total'
const DEFAULT_VOLUME_CONSTRAINT = false
/**
 * Along-channel stage smoothing window, calibrated in round nine. 250 m and
 * 500 m score identically (mean IoU 22.1%) and both improve every hindcast
 * site; wider windows keep helping the flat floodplains but destroy Hitoyoshi
 * (26.6% → 16.4% at 8 km), whose gorge reaches carry real per-reach signal.
 * 500 m is the middle of the plateau and stays a multi-cell window at every
 * DEM zoom, where 250 m collapses to a single cell. Set 0 to reproduce any
 * figure recorded before round nine.
 */
const DEFAULT_STAGE_SMOOTHING_M = 500
const DEFAULT_AREAL_REDUCTION = false
const DEFAULT_DYNAMIC_ROUTING = true
const DEFAULT_BACKWATER = false
/** Conservative screening assumptions where OSM records geometry but not operation. */
const DEFAULT_DAM_AVAILABLE_STORAGE_DEPTH_M = 0.5
const DEFAULT_STORM_SEWER_CAPACITY_MM_PER_HOUR = 15
const DEFAULT_STORM_SEWER_SERVICE_RADIUS_M = 100
const DEFAULT_MAXIMUM_BUILDING_BLOCKED_FRACTION = 0.8

const LIMITATIONS: ReadonlyArray<string> = [
  'Screening model and maximum-event envelope: channel arrival and peak time are estimated, but the returned polygons are the largest extent reached during the event, not time-indexed frames or a duration forecast.',
  'Momentum and backwater are one-dimensional channel controls over terrain-derived synthetic sections. Shallow-water characteristic speed is active in timed routing; standard-step backwater is available but off by default because four-event hindcasting showed that the coarse sections over-expand the flood envelope. Neither solves the full 2-D Saint-Venant equations, reverse flow, hydraulic jumps, bridge contractions or street-scale velocities.',
  'Channel cross-sections are inferred from drainage area using US-derived hydraulic geometry (Bieger et al. 2015), not surveyed. Capacity in any particular reach may be wrong by a factor of two or more.',
  'Levees, floodwalls, culverts, sewers, dams and buildings are below the resolution of a 30-90 m DEM, so their geometry comes from OpenStreetMap. Coverage is uneven and every reported benefit tracks it exactly; missing mapping is missing data, not an absence of infrastructure.',
  'Depth: quote p99DepthMetres, not maxDepthMetres. Spurious basins are carved open where a short outlet exists, but a deep one with no short way out is left filled and will own the maximum.',
  'Upstream catchment inflow applies the same storm to the whole external catchment. A lumped triangular unit hydrograph estimates delivery, arrival and peak; there is no observed baseflow, spatial rainfall field or gauged hydrograph assimilation.',
  'Dam attenuation is finite event storage, not an operating forecast: mapped normal-pool area is multiplied by an assumed available drawdown, with no gate schedule, initial observed reservoir level, controlled release hydrograph, overtopping, or dam-failure wave.',
  'Storm drainage removes runoff only near mapped drains, sewers and culverts, up to an assumed event-average capacity. OpenStreetMap rarely maps complete underground networks and the model has no inlet blockage, surcharge, pump outage, tide-locking or outfall backwater.',
  'Buildings displace sub-grid storage using mapped footprint fraction, which raises open-area depth while conserving that cell storage. The grid does not resolve wall-by-wall flow paths, doorway entry, basement flooding, structural failure or local velocity.',
  'The external catchment is measured over a bounded regional window, so a river whose headwaters lie beyond that window has its upstream area, and therefore its inflow, understated.',
  'Runoff uses one curve number for the whole area; local soil and land cover will make real runoff higher or lower.',
  'River inundation is mapped from each reach peak stage: everything standing below the event-maximum water surface is reported wet. That HAND envelope is deliberately generous and is not a simultaneous snapshot; validation figures must be read as envelope-versus-event comparisons.',
  "Floodplain roughness (floodplainManningN, default 0.10) is taken from Chow (1959) rather than calibrated, because it cannot be calibrated here: swept against the four hindcast events the score rises all the way to the edge of the physical range and past it, so those events do not identify a value. Extent is sensitive to it — 0.06 to 0.20 moves mean hit rate from 51% to 61% — so it is a stated assumption, not a fitted constant.",
  'network.volumeBudget reports whether the mapped water surface is one the river could have filled, but does not constrain it: measured at Joso the storm delivered about 1.0 km3 past the main stem against 0.42 km3 of mapped storage, so a whole-event volume budget has roughly twice the water it needs and never binds. Set volumeConstraint to make it act.',
  'Bankfull capacity is derived from the point rainfall at the query location, which overstates the catchment average and so understates flooding on a large basin. An areal reduction factor (Leclerc & Schaake 1972, as used in US NWS TP-29 — US-derived and applied globally, like the hydraulic geometry beside it) is available as arealReduction but is off by default; it was measured as changing the extent by under 0.1%.',
  'The stage is solved for the reach total discharge, so a reach floods to its full stage the moment its defences are passed. Solving instead for the excess over the defended capacity (stageDischarge: excess) is continuous and more physical, and is available, but measured against the four hindcast events it cost 1.4 points of hit rate for 0.2 of precision, so it is not the default.',
  'On very flat ground the reach slope approaches the model floor, and Manning then needs an implausibly high stage to pass the flow. Where method.maxRiverStageM is at the ladder limit (20 m), the stage is pegged rather than solved and the extent there is an upper bound, not an estimate.',
  'Upstream catchment area is taken from the regional flow network, which near a large confluence can attribute a neighbouring river system to the query point and overstate inflow.',
  'Mapped lakes, reservoirs and river channels are excluded from the reported extent, because they are already water rather than land that floods; permanentWater reports how much was removed and where the mapping came from. Only the mapped normal pool is excluded, so flooding beyond a shoreline is still reported — but a water body left off this map is not therefore safe, and where OpenStreetMap maps a channel wider or narrower than it is, the extent inherits that error.',
  'Storm surge and coastal flooding are out of scope; open water connected to the domain edge is treated as an outlet.',
  'Rainfall is applied uniformly from point samples; convective cells smaller than the query circle are smoothed out.',
  'This estimate never overrides official hazard maps or active warnings — where they disagree, trust the authorities.',
]

/** Grid cell containing a coordinate, or -1 if it falls outside the mosaic. */
const indexAt = (mosaic: ElevationMosaic, lon: number, lat: number): number => {
  const n = 2 ** mosaic.zoom
  const xf = ((lon + 180) / 360) * n
  const yf = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n
  const col = Math.floor((xf - mosaic.minTileX) * TILE_SIZE)
  const row = Math.floor((yf - mosaic.minTileY) * TILE_SIZE)
  if (col < 0 || col >= mosaic.width || row < 0 || row >= mosaic.height) return -1
  return row * mosaic.width + col
}

const cellLonLat = (
  mosaic: ElevationMosaic,
  geometry: MosaicGeometry,
  cell: number,
): { longitude: number; latitude: number } => ({
  longitude: columnLongitude(mosaic, cell % mosaic.width),
  latitude: geometry.rowLatitudes[Math.floor(cell / mosaic.width)]!,
})

const METRES_PER_DEGREE = 111_320

/** Straight-line ground distance from the query point, metres. */
const distanceFrom = (at: LonLat, longitude: number, latitude: number): number => {
  const dy = (latitude - at.latitude) * METRES_PER_DEGREE
  const dx = (longitude - at.longitude) * METRES_PER_DEGREE * Math.cos((at.latitude * Math.PI) / 180)
  return Math.hypot(dx, dy)
}

/**
 * Moves an injection point onto the local drainage line: the cell with the
 * largest contributing area within a small window. Used to land regional
 * inflow on the river rather than on the bank beside it.
 */
const snapToDrainage = (
  mosaic: ElevationMosaic,
  drainageAreaM2: Float64Array,
  cell: number,
  searchCells = 4,
): number => {
  const cx = cell % mosaic.width
  const cy = Math.floor(cell / mosaic.width)
  let best = cell
  let bestArea = drainageAreaM2[cell]!
  for (let dy = -searchCells; dy <= searchCells; dy++) {
    for (let dx = -searchCells; dx <= searchCells; dx++) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || nx >= mosaic.width || ny < 0 || ny >= mosaic.height) continue
      const ni = ny * mosaic.width + nx
      if (drainageAreaM2[ni]! > bestArea) {
        bestArea = drainageAreaM2[ni]!
        best = ni
      }
    }
  }
  return best
}

export const floodModelRoutes = (config: ServerConfig, proxyService?: GeoProxyService) => {
  const router = new Hono<AppEnv>()
  const proxy = proxyService ?? new GeoProxyService(config)

  router.post('/flood-model', async (c) => {
    let body: FloodModelRequestBody
    try {
      body = (await c.req.json()) as FloodModelRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    const latitude = body?.at?.latitude
    const longitude = body?.at?.longitude
    if (!numberInRange(latitude, -85, 85)) {
      return c.json(badRequest('at.latitude', 'Must be a latitude between -85 and 85'), 400)
    }
    if (!numberInRange(longitude, -180, 180)) {
      return c.json(badRequest('at.longitude', 'Must be a longitude between -180 and 180'), 400)
    }
    const at: LonLat = { latitude, longitude }

    const radiusKm = body.radiusKm ?? DEFAULT_RADIUS_KM
    if (!numberInRange(radiusKm, 1, MAX_RADIUS_KM)) {
      return c.json(badRequest('radiusKm', `Must be between 1 and ${MAX_RADIUS_KM} km`), 400)
    }
    const durationHours = body.durationHours ?? DEFAULT_DURATION_HOURS
    if (!numberInRange(durationHours, 1, MAX_DURATION_HOURS) || !Number.isInteger(durationHours)) {
      return c.json(badRequest('durationHours', `Must be an integer between 1 and ${MAX_DURATION_HOURS}`), 400)
    }
    const curveNumber = body.curveNumber ?? DEFAULT_CURVE_NUMBER
    if (!numberInRange(curveNumber, MIN_CURVE_NUMBER, MAX_CURVE_NUMBER)) {
      return c.json(badRequest('curveNumber', `Must be between ${MIN_CURVE_NUMBER} and ${MAX_CURVE_NUMBER}`), 400)
    }
    if (body.rainfallMm !== undefined && !numberInRange(body.rainfallMm, 0, MAX_DESIGN_STORM_MM)) {
      return c.json(badRequest('rainfallMm', `Must be between 0 and ${MAX_DESIGN_STORM_MM} mm`), 400)
    }
    const channelThresholdKm2 = body.channelThresholdKm2 ?? DEFAULT_CHANNEL_THRESHOLD_KM2
    if (!numberInRange(channelThresholdKm2, 0.1, 1000)) {
      return c.json(badRequest('channelThresholdKm2', 'Must be between 0.1 and 1000 km²'), 400)
    }
    const manningN = body.manningN ?? DEFAULT_MANNING_N
    if (!numberInRange(manningN, 0.01, 0.2)) {
      return c.json(badRequest('manningN', "Manning's n must be between 0.01 and 0.2"), 400)
    }
    const compoundMethod: CompoundMethod = body.compoundMethod ?? 'composite'
    if (compoundMethod !== 'composite' && compoundMethod !== 'divided') {
      return c.json(badRequest('compoundMethod', "Must be 'composite' or 'divided'"), 400)
    }
    const floodplainManningN = body.floodplainManningN ?? FLOODPLAIN_MANNING_N
    if (!numberInRange(floodplainManningN, 0.01, 0.3)) {
      return c.json(
        badRequest('floodplainManningN', "Floodplain Manning's n must be between 0.01 and 0.3"),
        400,
      )
    }
    const breachOptions = body.leveeBreach ?? {}
    const breachEnabled = breachOptions.enabled ?? true
    const breachWidthM = breachOptions.widthM ?? DEFAULT_BREACH_WIDTH_M
    if (!numberInRange(breachWidthM, 5, 2000)) {
      return c.json(badRequest('leveeBreach.widthM', 'Must be between 5 and 2000 m'), 400)
    }
    const maxBreaches = breachOptions.maxBreaches ?? DEFAULT_MAX_BREACHES
    if (!numberInRange(maxBreaches, 0, 20) || !Number.isInteger(maxBreaches)) {
      return c.json(badRequest('leveeBreach.maxBreaches', 'Must be an integer between 0 and 20'), 400)
    }
    if (body.upstreamRainfallMm !== undefined && !numberInRange(body.upstreamRainfallMm, 0, MAX_DESIGN_STORM_MM)) {
      return c.json(badRequest('upstreamRainfallMm', `Must be between 0 and ${MAX_DESIGN_STORM_MM} mm`), 400)
    }
    const channelDefenceMultiple = body.channelDefenceMultiple ?? DEFAULT_CHANNEL_DEFENCE_MULTIPLE
    if (!numberInRange(channelDefenceMultiple, 1, 100)) {
      return c.json(badRequest('channelDefenceMultiple', 'Must be between 1 and 100'), 400)
    }
    const useLevees = body.useLevees ?? true
    const leveeHeightM = body.leveeHeightM ?? DEFAULT_LEVEE_HEIGHT_M
    if (!numberInRange(leveeHeightM, 0.5, 30)) {
      return c.json(badRequest('leveeHeightM', 'Must be between 0.5 and 30 m'), 400)
    }
    const demBreachMinDepthM = body.demBreachMinDepthM ?? 5
    if (!numberInRange(demBreachMinDepthM, 0.25, 50)) {
      return c.json(badRequest('demBreachMinDepthM', 'Must be between 0.25 and 50 m'), 400)
    }
    const stageDischarge: StageDischarge = body.stageDischarge ?? DEFAULT_STAGE_DISCHARGE
    if (stageDischarge !== 'excess' && stageDischarge !== 'total') {
      return c.json(badRequest('stageDischarge', "Must be 'excess' or 'total'"), 400)
    }
    const stageSmoothingM = body.stageSmoothingM ?? DEFAULT_STAGE_SMOOTHING_M
    if (!numberInRange(stageSmoothingM, 0, 50_000)) {
      return c.json(badRequest('stageSmoothingM', 'Must be between 0 and 50000 m'), 400)
    }
    const wantVolumeConstraint = body.volumeConstraint ?? DEFAULT_VOLUME_CONSTRAINT
    const wantArealReduction = body.arealReduction ?? DEFAULT_AREAL_REDUCTION
    const wantChannelInflow = body.channelInflow ?? true
    const wantComponentZones = body.componentZones ?? false
    const wantDynamicRouting = body.dynamicRouting ?? DEFAULT_DYNAMIC_ROUTING
    if (typeof wantDynamicRouting !== 'boolean') {
      return c.json(badRequest('dynamicRouting', 'Must be a boolean'), 400)
    }
    const wantBackwater = body.backwater ?? DEFAULT_BACKWATER
    if (typeof wantBackwater !== 'boolean') {
      return c.json(badRequest('backwater', 'Must be a boolean'), 400)
    }
    if (wantBackwater && !wantDynamicRouting) {
      return c.json(badRequest('backwater', 'Requires dynamicRouting to be enabled'), 400)
    }

    const wantWaterMask = body.maskPermanentWater ?? true
    if (typeof wantWaterMask !== 'boolean') {
      return c.json(badRequest('maskPermanentWater', 'Must be a boolean'), 400)
    }
    const useDams = body.useDams ?? true
    if (typeof useDams !== 'boolean') {
      return c.json(badRequest('useDams', 'Must be a boolean'), 400)
    }
    const damAvailableStorageDepthM =
      body.damAvailableStorageDepthM ?? DEFAULT_DAM_AVAILABLE_STORAGE_DEPTH_M
    if (!numberInRange(damAvailableStorageDepthM, 0, 20)) {
      return c.json(badRequest('damAvailableStorageDepthM', 'Must be between 0 and 20 m'), 400)
    }
    const useStormSewers = body.useStormSewers ?? true
    if (typeof useStormSewers !== 'boolean') {
      return c.json(badRequest('useStormSewers', 'Must be a boolean'), 400)
    }
    const stormSewerCapacityMmPerHour =
      body.stormSewerCapacityMmPerHour ?? DEFAULT_STORM_SEWER_CAPACITY_MM_PER_HOUR
    if (!numberInRange(stormSewerCapacityMmPerHour, 0, 200)) {
      return c.json(badRequest('stormSewerCapacityMmPerHour', 'Must be between 0 and 200 mm/h'), 400)
    }
    const stormSewerServiceRadiusM =
      body.stormSewerServiceRadiusM ?? DEFAULT_STORM_SEWER_SERVICE_RADIUS_M
    if (!numberInRange(stormSewerServiceRadiusM, 0, 2000)) {
      return c.json(badRequest('stormSewerServiceRadiusM', 'Must be between 0 and 2000 m'), 400)
    }
    const useBuildings = body.useBuildings ?? true
    if (typeof useBuildings !== 'boolean') {
      return c.json(badRequest('useBuildings', 'Must be a boolean'), 400)
    }
    const maximumBuildingBlockedFraction =
      body.maximumBuildingBlockedFraction ?? DEFAULT_MAXIMUM_BUILDING_BLOCKED_FRACTION
    if (!numberInRange(maximumBuildingBlockedFraction, 0, 0.95)) {
      return c.json(
        badRequest('maximumBuildingBlockedFraction', 'Must be between 0 and 0.95'),
        400,
      )
    }

    const demSource = body.demSource ?? 'terrarium'
    if (!isDemSource(demSource)) {
      return c.json(badRequest('demSource', `Must be one of ${Object.keys(DEM_SOURCES).join(', ')}`), 400)
    }
    const demSpec = DEM_SOURCES[demSource]
    const demZoom = body.demZoom ?? demSpec.startZoom
    if (!Number.isInteger(demZoom) || demZoom < 6 || demZoom > demSpec.maxZoom) {
      return c.json(
        badRequest('demZoom', `Must be an integer between 6 and ${demSpec.maxZoom} for ${demSource}`),
        400,
      )
    }

    const fixtureMode = config.geoDataMode === 'fixture'
    const { zoom, range } = chooseDemZoom(at, radiusKm, config, demZoom)
    const contextRadiusKm = Math.min(radiusKm * CONTEXT_RADIUS_MULTIPLE, MAX_CONTEXT_RADIUS_KM)
    const context = chooseDemZoom(at, contextRadiusKm, config, CONTEXT_START_ZOOM)

    const cacheKey =
      `floodmodel:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}` +
      `:${radiusKm}:${zoom}:${body.rainfallMm ?? 'forecast'}:${durationHours}:${curveNumber}` +
      `:${channelThresholdKm2}:${manningN}:${channelDefenceMultiple}:${useLevees}:${leveeHeightM}:clim:${demBreachMinDepthM}` +
      `:${stageDischarge}:${wantVolumeConstraint}:${wantArealReduction}:${wantChannelInflow}:${body.upstreamRainfallMm ?? 'same'}:${breachEnabled}:${breachWidthM}:${maxBreaches}:${wantComponentZones}` +
      `:${floodplainManningN}:${compoundMethod}:${body.uniformStageM ?? 'off'}:${stageSmoothingM}:${config.geoDataMode}` +
      `:${demSource}:${wantWaterMask}:dynamic:${wantDynamicRouting}:backwater:${wantBackwater}` +
      `:infra:${useDams}:${damAvailableStorageDepthM}:${useStormSewers}:${stormSewerCapacityMmPerHour}:${stormSewerServiceRadiusM}:${useBuildings}:${maximumBuildingBlockedFraction}`
    const cached = proxy.getCache(cacheKey, config.geoCacheTtlFloodMs)
    if (cached) {
      c.header('x-cache-hit', 'true')
      c.header('x-cache-age-ms', String(cached.ageMs))
      return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
        'content-type': cached.entry.contentType,
      })
    }

    /** Wall-clock cost of each stage, so slow steps are visible not guessed at. */
    const timingsMs: Record<string, number> = {}
    let stageStarted = performance.now()
    const mark = (label: string): void => {
      timingsMs[label] = Math.round(performance.now() - stageStarted)
      stageStarted = performance.now()
    }

    try {
      const precipitation = await resolvePrecipitation(
        proxy, at, radiusKm, durationHours, body.rainfallMm, fixtureMode,
      )
      const runoff = estimateRunoff(precipitation.rainfallMm, curveNumber)
      const runoffMetres = runoff.runoffMm / 1000
      // The catchment upstream may have had a different storm from the town.
      const upstreamRainfallMm = body.upstreamRainfallMm ?? precipitation.rainfallMm
      const upstreamRunoff = estimateRunoff(upstreamRainfallMm, curveNumber)
      const durationSeconds = durationHours * 3600

      mark('precipitation')
      const { mosaic, cellsDespiked, cellsVoidFilled } = await loadTerrain(
        proxy, range, at, fixtureMode,
        { source: demSource, cacheDir: config.demCacheDir },
      )
      mark('terrain')
      // Carve outlets through dams the DEM invents where it cannot resolve a
      // gorge. Without this the model ponds tens of metres of water behind them.
      const breachReport = breachSpuriousDepressions(mosaic.elevations, mosaic.width, mosaic.height, {
        oceanLevelMetres: 0,
        minDepthMetres: demBreachMinDepthM,
      })
      // Breaching has already filled these elevations; reuse its surface rather
      // than repeating a Priority-Flood pass over a million cells.
      const surface = breachReport.surface
      mark('demBreaching')
      const geometry = mosaicGeometry(mosaic)
      const cellCount = mosaic.width * mosaic.height
      const midRow = Math.floor(mosaic.height / 2)
      const meanCellMetres = Math.round(
        (geometry.rowCellWidthM[midRow]! + geometry.rowCellHeightM[midRow]!) / 2,
      )

      // Static mapped infrastructure. Its disk store lives below the OSM water
      // cache because both datasets have the same source, lifetime, and reuse
      // contract; the subdirectory keeps their records disjoint.
      const wantInfrastructure = useDams || useStormSewers || useBuildings
      const infrastructure = wantInfrastructure
        ? await loadInfrastructure(proxy, mosaic.bbox, fixtureMode, {
            cacheDir: config.waterCacheDir,
          })
        : {
            dams: [],
            drains: [],
            buildings: [],
            damElements: 0,
            drainElements: 0,
            buildingElements: 0,
            truncated: false,
            status: 'disabled by request',
            retrievedFrom: 'none' as const,
          }
      const infrastructureRaster = rasteriseInfrastructure(
        infrastructure,
        mosaic,
        Math.round(stormSewerServiceRadiusM / meanCellMetres),
      )
      mark('infrastructure')

      // Reservoir polygons serve two separate purposes: normal-pool masking and
      // the finite storage assigned to a mapped dam. Turning one off must not
      // silently deprive the other of its input.
      const wantWaterData = wantWaterMask || useDams
      const water = wantWaterData
        ? await loadWater(proxy, mosaic.bbox, fixtureMode, { cacheDir: config.waterCacheDir })
        : {
            bodies: [],
            wayCount: 0,
            relationCount: 0,
            status: 'disabled by request',
            retrievedFrom: 'none' as const,
          }
      const waterRaster = rasteriseWaterBodies(water.bodies, mosaic)
      mark('waterData')

      // ---- Drainage network over the query window --------------------------
      const receivers = d8Receivers(surface, mosaic.width, mosaic.height, geometry)
      const cellAreas = new Float64Array(cellCount)
      for (let i = 0; i < cellCount; i++) cellAreas[i] = geometry.rowCellAreaM2[Math.floor(i / mosaic.width)]!
      const drainageAreaM2 = flowAccumulate(receivers, surface.popOrder, cellAreas)
      mark('network')

      // ---- Channel inflow from the catchment upstream of the window --------
      const inflowM3 = new Float64Array(cellCount)
      /**
       * Catchment area arriving with that inflow. Without it an inlet cell is
       * sized for its own hillslope while carrying a whole river, which is how
       * a reach ended up 1 181x "over capacity".
       */
      const externalAreaSeedM2 = new Float64Array(cellCount)
      const inlets: Array<{
        latitude: number
        longitude: number
        externalCatchmentKm2: number
        dischargeM3PerS: number
        volumeM3: number
        peakDischargeM3PerS: number
        timeOfConcentrationHours: number
        arrivalTimeHours: number
        peakTimeHours: number
        basinReliefM: number
        attenuation: number
      }> = []
      let externalInflowM3 = 0
      let externalCatchmentKm2 = 0

      if (wantChannelInflow && !fixtureMode) {
        /**
         * The context window stays on the global source whatever the scored
         * window uses. Two reasons, and they agree: at 60 km it routinely
         * reaches past a national survey's coastline, where a regional set has
         * no tile to serve and the inflow term would fail rather than degrade;
         * and holding it fixed keeps a DEM comparison a comparison, since the
         * upstream inflow arriving at the window is then identical across
         * sources. Only relative elevation within this mosaic is used — to find
         * inlets and the area draining to them — so it never has to agree with
         * the scored window's datum.
         */
        const ctx = await loadTerrain(proxy, context.range, at, false, {
          source: 'terrarium',
          cacheDir: config.demCacheDir,
        })
        const ctxGeometry = mosaicGeometry(ctx.mosaic)
        const ctxCells = ctx.mosaic.width * ctx.mosaic.height
        const ctxSurface = priorityFlood(ctx.mosaic.elevations, ctx.mosaic.width, ctx.mosaic.height, 0)
        const ctxReceivers = d8Receivers(ctxSurface, ctx.mosaic.width, ctx.mosaic.height, ctxGeometry)
        const ctxAreas = new Float64Array(ctxCells)
        for (let i = 0; i < ctxCells; i++) {
          ctxAreas[i] = ctxGeometry.rowCellAreaM2[Math.floor(i / ctx.mosaic.width)]!
        }
        const ctxDrainage = flowAccumulate(ctxReceivers, ctxSurface.popOrder, ctxAreas)
        // Headwater relief above each cell, for the basin-average channel
        // gradient Kirpich actually asks for.
        const ctxElevations = new Float64Array(ctxCells)
        for (let i = 0; i < ctxCells; i++) ctxElevations[i] = ctx.mosaic.elevations[i]!
        const ctxUpstreamPeak = flowAccumulateMax(ctxReceivers, ctxSurface.popOrder, ctxElevations)

        const radiusM = radiusKm * 1000
        const insideCache = new Uint8Array(ctxCells)
        for (let i = 0; i < ctxCells; i++) {
          const { longitude: lo, latitude: la } = cellLonLat(ctx.mosaic, ctxGeometry, i)
          insideCache[i] = distanceFrom(at, lo, la) <= radiusM ? 1 : 0
        }

        for (const inlet of findInlets(
          ctxReceivers, ctxDrainage, (cell) => insideCache[cell] === 1, channelThresholdKm2 * 1e6,
        )) {
          const { longitude: lo, latitude: la } = cellLonLat(ctx.mosaic, ctxGeometry, inlet.cell)
          const mapped = indexAt(mosaic, lo, la)
          if (mapped < 0) continue

          // The inlet was located on the coarse regional grid, so its position
          // on the fine grid can miss the channel by a cell or two. Dropping a
          // river's discharge onto the hillslope beside it produces a headwater
          // ditch carrying thousands of cubic metres a second, so the injection
          // is snapped to the largest drainage line in the immediate
          // neighbourhood.
          const target = snapToDrainage(mosaic, drainageAreaM2, mapped)

          const inletAreaKm2 = inlet.areaM2 / 1e6
          const reliefM = Math.max(1, ctxUpstreamPeak[inlet.cell]! - ctx.mosaic.elevations[inlet.cell]!)
          const basinSlope = reliefM / (mainChannelLengthKm(inletAreaKm2) * 1000)
          const delivery = deliverableInflow(inletAreaKm2, upstreamRunoff.runoffMm, durationHours, basinSlope)
          if (delivery.volumeM3 <= 0) continue

          inflowM3[target]! += delivery.volumeM3
          externalAreaSeedM2[target]! += inlet.areaM2
          externalInflowM3 += delivery.volumeM3
          externalCatchmentKm2 += inlet.areaM2 / 1e6
          if (inlets.length < MAX_INLETS_REPORTED) {
            inlets.push({
              latitude: Math.round(la * 1e5) / 1e5,
              longitude: Math.round(lo * 1e5) / 1e5,
              externalCatchmentKm2: Math.round((inlet.areaM2 / 1e6) * 10) / 10,
              dischargeM3PerS: Math.round((delivery.volumeM3 / durationSeconds) * 10) / 10,
              volumeM3: Math.round(delivery.volumeM3),
              peakDischargeM3PerS: Math.round(delivery.peakDischargeM3PerS * 10) / 10,
              timeOfConcentrationHours: Math.round(delivery.timeOfConcentrationHours * 10) / 10,
              arrivalTimeHours: Math.round(0.6 * delivery.timeOfConcentrationHours * 10) / 10,
              peakTimeHours: Math.round(delivery.timeToPeakHours * 10) / 10,
              basinReliefM: Math.round(reliefM),
              attenuation: Math.round(delivery.attenuation * 100) / 100,
            })
          }
        }
      }

      mark('channelInflow')
      /**
       * Total contributing area, counting what arrives from outside the window.
       * A river is a river from where it enters, not from where it has gathered
       * enough local hillslope to look like one.
       */
      const totalCatchmentM2 = flowAccumulate(
        receivers,
        surface.popOrder,
        Float64Array.from(cellAreas, (a, i) => a + externalAreaSeedM2[i]!),
      )
      const isChannel = channelMask(totalCatchmentM2, channelThresholdKm2 * 1e6)
      const slope = downstreamSlope(
        surface, receivers, mosaic.width, geometry,
        Math.max(4, Math.round(SLOPE_REACH_METRES / meanCellMetres)),
      )
      // Headwater relief above every reach is needed by both the local
      // climatology geometry and the event hydrograph timing. Compute it once.
      const upstreamPeakElevationM = flowAccumulateMax(
        receivers,
        surface.popOrder,
        Float64Array.from(mosaic.elevations),
      )

      // ---- Route it, and compare against what the channels can carry -------
      const rawLocalRunoffM3 = new Float64Array(cellCount)
      let rainfallRunoffM3 = 0
      for (let i = 0; i < cellCount; i++) {
        rawLocalRunoffM3[i] = runoffMetres * cellAreas[i]!
        rainfallRunoffM3 += rawLocalRunoffM3[i]!
      }
      const stormDrainage = useStormSewers
        ? applyStormDrainage(
            rawLocalRunoffM3,
            infrastructureRaster.isDrainServed,
            geometry.rowCellAreaM2,
            mosaic.width,
            stormSewerCapacityMmPerHour,
            durationHours,
          )
        : {
            surfaceRunoffM3: Float64Array.from(rawLocalRunoffM3),
            capturedM3: 0,
            servicedWetCells: 0,
          }
      const localVolumeM3 = new Float64Array(cellCount)
      for (let i = 0; i < cellCount; i++) {
        localVolumeM3[i] = stormDrainage.surfaceRunoffM3[i]! + inflowM3[i]!
      }
      const damRouting = routeThroughDams({
        localVolumeM3,
        receivers,
        popOrder: surface.popOrder,
        drainageAreaM2: totalCatchmentM2,
        isDam: useDams ? infrastructureRaster.isDam : new Uint8Array(cellCount),
        isWater: waterRaster.isWater,
        rowCellAreaM2: geometry.rowCellAreaM2,
        width: mosaic.width,
        height: mosaic.height,
        availableStorageDepthM: damAvailableStorageDepthM,
        snapRadiusCells: Math.max(2, Math.round(250 / meanCellMetres)),
      })
      const routedVolumeM3 = damRouting.routedVolumeM3

      /**
       * Bankfull capacity from the catchment's own climate.
       *
       * A channel is in equilibrium with roughly its two-year flow, so the
       * mean annual flood *is* the bankfull discharge — no cross-section
       * extrapolation, and no Manning, whose square-root dependence on a slope
       * that is largely DEM quantisation was amplifying the error. Basin
       * gradient comes from headwater relief over Hack length, as it does for
       * the inflow inlets.
       */
      mark('routing')
      const climate = await loadRainfallClimatology(proxy, at, fixtureMode, {
        cacheDir: config.climateCacheDir,
      })
      mark('climatology')
      const bankfullDischargeM3PerS = new Float64Array(cellCount)
      if (climate.rain2yrMm > 0) {
        for (let i = 0; i < cellCount; i++) {
          if (!isChannel[i]) continue
          const areaKm2 = totalCatchmentM2[i]! / 1e6
          const reliefM = Math.max(1, upstreamPeakElevationM[i]! - mosaic.elevations[i]!)
          const basinSlope = reliefM / (mainChannelLengthKm(areaKm2) * 1000)
          bankfullDischargeM3PerS[i] = meanAnnualFloodM3PerS(
            areaKm2, climate.rain2yrMm, curveNumber, basinSlope,
            { arealReduction: wantArealReduction },
          )
        }
      }
      const usingClimateGeometry = climate.rain2yrMm > 0

      const channels = channelGeometry(
        totalCatchmentM2, slope, isChannel, manningN,
        usingClimateGeometry ? bankfullDischargeM3PerS : undefined,
      )
      const conveyance = conveyanceVolumeM3(channels.capacityM3PerS, durationSeconds)
      const eventAverageDischargeM3PerS = new Float64Array(cellCount)
      for (let i = 0; i < cellCount; i++) {
        eventAverageDischargeM3PerS[i] = routedVolumeM3[i]! / durationSeconds
      }
      const floodWave = wantDynamicRouting
        ? estimateFloodWave({
            routedVolumeM3,
            drainageAreaM2: totalCatchmentM2,
            elevations: mosaic.elevations,
            headwaterElevationM: upstreamPeakElevationM,
            isChannel,
            channelWidthM: channels.widthM,
            channelDepthM: channels.depthM,
            channelCapacityM3PerS: channels.capacityM3PerS,
            durationHours,
          })
        : null
      const dischargeM3PerS = floodWave?.peakDischargeM3PerS ?? eventAverageDischargeM3PerS
      const overtopping = assessDischargeOvertopping(
        dischargeM3PerS,
        channels.capacityM3PerS,
        isChannel,
      )
      mark('hydrograph')

      // ---- Levee breaches --------------------------------------------------
      let breaches: ReadonlyArray<BreachSite> = []
      if (breachEnabled && maxBreaches > 0 && overtopping.overtoppingCells > 0) {
        const candidates = Array.from({ length: cellCount }, (_, i) => i)
          .filter((i) => isChannel[i] === 1 && overtopping.ratio[i]! > 1)
          .sort((a, b) => overtopping.ratio[b]! - overtopping.ratio[a]!)
          .slice(0, 400)

        breaches = planBreaches({
          candidates,
          drainageAreaM2: totalCatchmentM2,
          overtopRatio: overtopping.ratio,
          channelDepthM: channels.depthM,
          routedVolumeM3,
          conveyanceM3: conveyance,
          durationSeconds,
          breachWidthM,
          maxBreaches,
          minSeparationCells: Math.max(2, Math.round(MIN_BREACH_SEPARATION_M / meanCellMetres)),
          width: mosaic.width,
        })

        // A breach takes water out of the channel, so the reach around it can
        // no longer carry that volume past: the conveyance it loses is exactly
        // what goes through the gap.
        for (const site of breaches) {
          const bx = site.cell % mosaic.width
          const by = Math.floor(site.cell / mosaic.width)
          for (let dy = -BREACH_INFLUENCE_CELLS; dy <= BREACH_INFLUENCE_CELLS; dy++) {
            for (let dx = -BREACH_INFLUENCE_CELLS; dx <= BREACH_INFLUENCE_CELLS; dx++) {
              const nx = bx + dx
              const ny = by + dy
              if (nx < 0 || nx >= mosaic.width || ny < 0 || ny >= mosaic.height) continue
              const ni = ny * mosaic.width + nx
              if (!isChannel[ni]) continue
              conveyance[ni] = Math.max(0, conveyance[ni]! - site.volumeM3)
            }
          }
        }
      }

      // ---- Spread: pluvial baseline, then the coupled model -----------------
      const pluvialOnly = spreadRunoff({
        elevations: mosaic.elevations,
        width: mosaic.width,
        height: mosaic.height,
        runoffMetres: 0,
        rowCellAreaM2: geometry.rowCellAreaM2,
        oceanLevelMetres: 0,
        surface,
        inflowM3: stormDrainage.surfaceRunoffM3,
      })

      const spreadWith = (conveyanceM3: Float64Array) =>
        spreadRunoff({
          elevations: mosaic.elevations,
          width: mosaic.width,
          height: mosaic.height,
          runoffMetres: 0,
          rowCellAreaM2: geometry.rowCellAreaM2,
          oceanLevelMetres: 0,
          surface,
          inflowM3: localVolumeM3,
          conveyanceM3,
        })

      /**
       * Stage-dependent conveyance, solved by iteration.
       *
       * Bankfull alone makes every valley a bathtub in a large event: a 772 km²
       * river carries ~34 m³/s at bankfull against thousands in flood, so the
       * conveyance term all but vanishes and the model saturates. Once out of
       * bank the floodplain conveys too, but how much depends on how wide the
       * flood is — which depends on the conveyance. So: solve for the fixed
       * point, damped, starting from bankfull.
       *
       * Depression labels come from the terrain alone, so they are stable
       * across passes and can be gathered once.
       */
      mark('breachPlanning')
      const coupled = spreadWith(conveyance)
      mark('spreading')

      /**
       * Fluvial inundation, by HAND rather than by fill-and-spill.
       *
       * Steady-state ponding cannot produce river flooding: a floodplain with
       * an outlet stores nothing at equilibrium, so the fill model only ever
       * inundates closed basins. The river's own contribution is therefore
       * computed as a stage — discharge in, water surface out, through a rating
       * curve built from the terrain around each reach — and everything
       * standing below that surface is wet.
       */
      mark('pluvialBaseline')
      const { hand, nearestChannel } = heightAboveDrainage(
        mosaic.elevations, receivers, surface.popOrder, isChannel,
      )

      /**
       * What each reach is defended to, m³/s — the one number the stage solve
       * and the volume budget both hang off. A breach is a defence failure, so
       * the conveyance it took out of the channel comes off the defended
       * discharge too; at the default multiple of 1 and no breaches this is
       * exactly the bankfull capacity, as it was before.
       */
      const defendedCapacityM3PerS = new Float64Array(cellCount)
      const overbankVolumeM3 = new Float64Array(cellCount)
      for (let i = 0; i < cellCount; i++) {
        if (!isChannel[i]) continue
        const bankfullVolumeM3 = channels.capacityM3PerS[i]! * durationSeconds
        const breachLossM3 = Math.max(0, bankfullVolumeM3 - conveyance[i]!)
        defendedCapacityM3PerS[i] = Math.max(
          0, channels.capacityM3PerS[i]! * channelDefenceMultiple - breachLossM3 / durationSeconds,
        )
        overbankVolumeM3[i] = Math.max(
          0,
          routedVolumeM3[i]! - defendedCapacityM3PerS[i]! * durationSeconds,
        )
      }

      const fluvial = fluvialInundation({
        hand,
        nearestChannel,
        isChannel,
        dischargeM3PerS,
        defendedCapacityM3PerS,
        stageDischarge,
        floodplainRoughness: floodplainManningN,
        compoundMethod,
        uniformStageM: body.uniformStageM,
        stageSmoothingM,
        volumeConstraint: wantVolumeConstraint,
        receivers,
        popOrder: surface.popOrder,
        durationSeconds,
        overbankVolumeM3,
        slope,
        rowCellAreaM2: geometry.rowCellAreaM2,
        reachLengthM: meanCellMetres,
        width: mosaic.width,
        height: mosaic.height,
        roughness: manningN,
        hydraulicEffects:
          floodWave !== null && wantBackwater && body.uniformStageM === undefined
            ? {
                elevations: mosaic.elevations,
                receivers,
                popOrder: surface.popOrder,
                peakDischargeM3PerS: floodWave.peakDischargeM3PerS,
                arrivalTimeHours: floodWave.arrivalTimeHours,
                peakTimeHours: floodWave.peakTimeHours,
                channelWidthM: channels.widthM,
                channelDepthM: channels.depthM,
                roughness: floodplainManningN,
                eventDurationHours: durationHours,
              }
            : undefined,
      })

      /**
       * Defences. A DEM at this resolution carries no embankments, so mapped
       * ones are burned on and the river's reach is restricted to what it can
       * actually get to: land behind an un-overtopped crest stays dry, and a
       * breach is the gap the water goes through.
       *
       * Applied to the fluvial field only — rain still falls behind a levee.
       */
      mark('fluvialStage')
      const levees = useLevees
        ? await loadLevees(proxy, mosaic.bbox, fixtureMode, { cacheDir: config.leveeCacheDir })
        : { segments: [], wayCount: 0, withRecordedHeight: 0, status: 'disabled by request' }
      const leveeRaster = rasteriseLevees(levees.segments, mosaic, leveeHeightM)
      const breachOpen = openBreaches(
        breaches.map((b) => b.cell),
        mosaic.width,
        mosaic.height,
        Math.max(1, Math.round(breachWidthM / meanCellMetres)),
      )
      const defended =
        leveeRaster.leveeCells > 0
          ? applyLeveeProtection({
              depths: fluvial.depths,
              stageM: fluvial.stageM,
              nearestChannel,
              isChannel,
              elevations: mosaic.elevations,
              crestM: leveeRaster.crestM,
              breachOpen,
              width: mosaic.width,
              height: mosaic.height,
            })
          : { depths: fluvial.depths, protectedCells: 0, reachedCells: 0 }

      mark('defences')
      // Two mechanisms, one water surface: the deeper of the two, never the sum.
      const combinedWithoutBuildings = combineDepths(coupled.depths, defended.depths)
      const accountForBuildings = (depths: Float32Array) =>
        useBuildings
          ? applyBuildingStorageDisplacement(
              depths,
              infrastructureRaster.buildingFraction,
              maximumBuildingBlockedFraction,
            )
          : { depths, adjustedCells: 0, maxDepthMultiplier: 1 }
      const buildingAdjustment = accountForBuildings(combinedWithoutBuildings)
      const rawCombinedDepths = buildingAdjustment.depths
      const pluvialDepths = accountForBuildings(pluvialOnly.depths).depths
      const fluvialDepths = accountForBuildings(defended.depths).depths
      const undefendedDepths = accountForBuildings(fluvial.depths).depths

      /**
       * Standing water is not flood.
       *
       * The model reads terrain and cannot tell a lake from low ground, so both
       * mechanisms are drawn to one: the basin is a closed depression that ponds
       * rain and never drains in steady state, and it carries the drainage
       * network so the river stage covers it too. Left in, it reported Lake
       * Nojiri as 2 km² of flood, and standing water was 15-33% of the
       * false-positive area at every hindcast site.
       *
       * Only the normal pool is removed — a cell has to be wet already — so
       * flooding beyond a shoreline survives and the extent still ends where the
       * water stops being ordinary. An outage restores the old, over-generous
       * extent rather than losing the request, which is the safe direction.
       */
      const maskWater = (depths: Float32Array): Float32Array =>
        wantWaterMask && waterRaster.waterCells > 0
          ? maskPermanentWater(depths, waterRaster.isWater, geometry.rowCellAreaM2, mosaic.width)
              .depths
          : depths
      const waterMask = wantWaterMask
        ? maskPermanentWater(
            rawCombinedDepths,
            waterRaster.isWater,
            geometry.rowCellAreaM2,
            mosaic.width,
          )
        : { depths: rawCombinedDepths, maskedCells: 0, maskedAreaM2: 0 }
      const combinedDepths = waterMask.depths
      mark('permanentWater')

      const summary = summariseDepthsInCircle(mosaic, geometry, combinedDepths, at, radiusKm)
      /**
       * Measured inside the query circle, like every other area here. The cell
       * count behind it spans the whole mosaic, which is the tile rectangle
       * around the circle and materially larger — reporting that number beside a
       * circle-clipped extent invited exactly the comparison it would fail.
       */
      const waterAreaInCircleKm2 =
        wantWaterMask && waterRaster.waterCells > 0
          ? summariseDepthsInCircle(mosaic, geometry, rawCombinedDepths, at, radiusKm)
              .floodedAreaKm2 - summary.floodedAreaKm2
          : 0
      // Masked on the same footing as the reported extent, so `attribution`
      // describes the answer the caller got rather than one it never saw.
      const pluvialSummary = summariseDepthsInCircle(mosaic, geometry, maskWater(pluvialDepths), at, radiusKm)
      const fluvialSummary = summariseDepthsInCircle(mosaic, geometry, maskWater(fluvialDepths), at, radiusKm)
      const undefendedSummary = summariseDepthsInCircle(mosaic, geometry, maskWater(undefendedDepths), at, radiusKm)

      const retrievedAt = Date.now()
      const designEvent =
        `${precipitation.rainfallMm} mm / ${durationHours} h rainfall, CN ${curveNumber}` +
        `${externalInflowM3 > 0 ? `, plus ${Math.round(externalCatchmentKm2)} km² upstream inflow` : ''}` +
        `${breaches.length > 0 ? `, ${breaches.length} levee breach(es)` : ''}` +
        `${damRouting.sites.length > 0 ? `, ${damRouting.sites.length} mapped dam site(s)` : ''}` +
        `${stormDrainage.capturedM3 > 0 ? ', mapped storm drainage active' : ''}`
      const provenance: Provenance = {
        sourceId: 'estimate.fluvial.coupled',
        sourceName: 'Model estimate: coupled pluvial-fluvial routing over Terrarium DEM',
        upstreamUrl: fixtureMode
          ? 'fixture:synthetic-dem'
          : DEM_SOURCES[demSource].url(zoom, range.minX, range.minY),
        datasetVintage: fixtureMode ? 'synthetic' : 'Mapzen/AWS Terrain Tiles (static compilation)',
        retrievedAt,
        cache: { hit: false, ageMs: 0 },
        licence: fixtureMode ? 'n/a (synthetic)' : 'ODbL / public domain (see attribution)',
        attribution: fixtureMode ? 'Synthetic fixture terrain' : DEM_SOURCES[demSource].attribution,
        mode: fixtureMode ? 'fixture' : 'live',
      }

      mark('summarise')
      const classified = depthsToClassifiedTiles(mosaic, combinedDepths)
      /**
       * Vectorised at the model's own cell size, deliberately.
       *
       * Vectorisation is the most expensive stage here, and coarsening it is
       * the obvious saving — it was tried and rejected. `coarsen` takes the
       * worst class in each block, so a coarser cell rounds the extent outward:
       * measured at Joso the returned polygons covered 292 km² at 1x (matching
       * the computed area exactly), 454 km² at 2x and 619 km² at 3x, against a
       * grid figure of 292.6 km² throughout. Halving the request time by
       * overstating flooded ground by 55% is not a trade a safety tool should
       * make, and it would put `inundation.zones` at odds with
       * `inundation.floodedAreaKm2`.
       */
      const rawZones = rasterTilesToFloodZones([...classified], provenance, designEvent)
      mark('vectorise')
      const { zones } = clipAndMergeZones(rawZones, at, radiusKm)
      mark('clipToCircle')

      /**
       * The two mechanisms as separate extents, on request. Same pipeline as
       * the combined field, so a component zone is comparable with a reported
       * one cell for cell.
       */
      const vectoriseField = (depths: Float32Array) =>
        clipAndMergeZones(
          rasterTilesToFloodZones([...depthsToClassifiedTiles(mosaic, depths)], provenance, designEvent),
          at,
          radiusKm,
        ).zones
      /**
       * The fluvial field restricted to water standing under a reach the stage
       * ladder could not solve. A pegged reach's stage is the ladder's top rung,
       * not an answer, and accuracy work keeps needing to ask how much of the
       * extent — and of the error — that failure mode owns.
       */
      const peggedFluvialDepths = (): Float32Array => {
        const masked = new Float32Array(defended.depths.length)
        for (let i = 0; i < masked.length; i++) {
          const reach = nearestChannel[i]!
          if (reach >= 0 && fluvial.pegged[reach] === 1) masked[i] = fluvialDepths[i]!
        }
        return masked
      }
      const componentZones = wantComponentZones
        ? {
            pluvial: vectoriseField(maskWater(pluvialDepths)),
            fluvial: vectoriseField(maskWater(fluvialDepths)),
            fluvialPegged: vectoriseField(maskWater(peggedFluvialDepths())),
          }
        : null
      if (wantComponentZones) mark('componentZones')

      let maxDrainageAreaM2 = 0
      let drainServiceAreaM2 = 0
      let buildingFootprintAreaM2 = 0
      for (let i = 0; i < cellCount; i++) {
        if (totalCatchmentM2[i]! > maxDrainageAreaM2) maxDrainageAreaM2 = totalCatchmentM2[i]!
        const cellAreaM2 = geometry.rowCellAreaM2[Math.floor(i / mosaic.width)]!
        if (infrastructureRaster.isDrainServed[i] === 1) drainServiceAreaM2 += cellAreaM2
        buildingFootprintAreaM2 += infrastructureRaster.buildingFraction[i]! * cellAreaM2
      }

      // The main stem: the reach the areal reduction is quoted for, since the
      // factor depends on catchment area and so differs for every reach.
      let trunkCell = -1
      for (let i = 0; i < cellCount; i++) {
        if (isChannel[i] && (trunkCell < 0 || totalCatchmentM2[i]! > totalCatchmentM2[trunkCell]!)) {
          trunkCell = i
        }
      }
      const trunkCatchmentKm2 = trunkCell >= 0 ? totalCatchmentM2[trunkCell]! / 1e6 : 0
      const trunkArealReduction = wantArealReduction
        ? arealReductionFactor(CLIMATOLOGY_ACCUMULATION_HOURS, trunkCatchmentKm2)
        : 1

      const response = {
        ok: true,
        mode: config.geoDataMode,
        location: { latitude, longitude },
        radiusKm,
        method: {
          name: 'Coupled pluvial-fluvial event-envelope model',
          components: {
            pluvial: 'SCS-CN runoff, USDA-NRCS Technical Release 55 (1986)',
            network: 'D8 flow directions and contributing area (O’Callaghan & Mark 1984) over a Priority-Flood filled DEM (Barnes, Lehman & Mulla 2014)',
            routing: wantDynamicRouting
              ? 'timed SCS triangular flood-wave peak over the routed event-volume network (USDA-NRCS NEH 630-16)'
              : 'legacy event-average downstream accumulation of runoff volume',
            momentum: wantDynamicRouting
              ? 'shallow-water characteristic speed and velocity head in the reach energy balance (Bates, Horritt & Fewtrell 2010)'
              : 'disabled by request',
            backwater: wantBackwater
              ? 'subcritical standard-step water-surface profile with friction and velocity head (USACE HEC-RAS)'
              : 'available but disabled; four-event hindcasting rejects it as a default on coarse synthetic sections',
            channel: 'bankfull hydraulic geometry (Bieger et al. 2015) with Manning conveyance (Chow 1959)',
            channelInflow: 'upstream catchment runoff injected where regional channels cross into the query window, capped by an SCS triangular unit-hydrograph peak (NEH-630-16) over Kirpich (1940) time of concentration',
            leveeBreach: 'broad-crested weir outflow (Chow 1959; cf. USACE HEC-RAS) applied as local channel conveyance loss',
            dams: 'finite reservoir attenuation at mapped dams: upstream mapped normal-pool area × available event drawdown',
            stormDrainage: 'finite event-capacity runoff removal within the service radius of mapped storm drains, sewers, drains and culverts',
            buildings: 'sub-grid building porosity: mapped footprint displaces cell storage and raises open-area depth',
            spreading: 'level-pool fill-spill-convey (cf. Lhomme et al. 2008; Barnes, Callaghan & Wickert 2020)',
          },
          dem: fixtureMode ? 'synthetic fixture terrain' : 'Mapzen/AWS Terrain Tiles, Terrarium encoding',
          demSource,
          demZoom: zoom,
          demCellMetres: meanCellMetres,
          demCellsDespiked: cellsDespiked,
          demCellsVoidFilled: cellsVoidFilled,
          demBreachMinDepthM,
          demDepressionsBreached: breachReport.depressionsBreached,
          demCellsCarved: breachReport.cellsCarved,
          demDeepestDepressionBeforeM: Math.round(breachReport.deepestBeforeMetres * 10) / 10,
          demDeepestDepressionAfterM: Math.round(breachReport.deepestAfterMetres * 10) / 10,
          fluvialMethod: 'HAND with a terrain-derived synthetic rating curve (Nobre et al. 2011; Zheng et al. 2018)',
          maxRiverStageM: Math.round(fluvial.maxStageM * 10) / 10,
          slopeReachMetres: SLOPE_REACH_METRES,
          stageDischarge,
          stageSmoothingM,
          dynamicRouting: wantDynamicRouting,
          backwater: wantBackwater,
          volumeConstraint: wantVolumeConstraint,
          arealReduction: wantArealReduction,
          channelDefenceMultiple,
          leveeHeightM,
          damAvailableStorageDepthM,
          stormSewerCapacityMmPerHour,
          stormSewerServiceRadiusM,
          maximumBuildingBlockedFraction,
          bankfullCapacityFrom: usingClimateGeometry
            ? 'mean annual flood from ERA5 rainfall climatology (Moody & Troutman cross-section)'
            : 'area-keyed hydraulic geometry through Manning (Bieger et al. 2015) — understates large rivers by orders of magnitude',
          gridCells: cellCount,
          contextZoom: wantChannelInflow && !fixtureMode ? context.zoom : null,
          contextRadiusKm: wantChannelInflow && !fixtureMode ? contextRadiusKm : null,
          channelThresholdKm2,
          manningN,
          /**
           * Equal to `manningN` means the single-section curve: one roughness
           * across the whole flooded width. The two are different enough that a
           * figure from one cannot be compared with a figure from the other.
           */
          floodplainManningN,
          compoundMethod,
          depthBands: INUNDATION_BANDS,
        },
        precipitation: precipitation.detail,
        runoff: {
          curveNumber,
          rainfallMm: runoff.rainfallMm,
          runoffMm: Math.round(runoff.runoffMm * 100) / 100,
          initialAbstractionMm: Math.round(runoff.initialAbstractionMm * 100) / 100,
          potentialRetentionMm: Math.round(runoff.potentialRetentionMm * 100) / 100,
        },
        network: {
          channelCells: overtopping.channelCells,
          approxChannelLengthKm: Math.round((overtopping.channelCells * meanCellMetres) / 1000),
          maxDrainageAreaKm2: Math.round((maxDrainageAreaM2 / 1e6) * 10) / 10,
          peakDischargeM3PerS: Math.round(overtopping.peakDischargeM3PerS * 10) / 10,
          overtoppingCells: overtopping.overtoppingCells,
          reachesDefended: fluvial.defendedReaches,
          reachesStagePegged: fluvial.peggedReaches,
          reachesVolumeLimited: fluvial.volumeLimitedReaches,
          // Evaluated on every request, applied only when asked: whether the
          // mapped water surface is one the river could actually have filled
          // is worth knowing even where it is not allowed to change the answer.
          volumeBudget: fluvial.volumeBudget && {
            mappedStorageM3: Math.round(fluvial.volumeBudget.mappedStorageM3),
            trunkOverbankVolumeM3: Math.round(fluvial.volumeBudget.trunkOverbankVolumeM3),
            trunkCumulativeStorageM3: Math.round(fluvial.volumeBudget.trunkCumulativeStorageM3),
            minimumSupportedShare: Math.round(fluvial.volumeBudget.minimumSupportedShare * 1000) / 1000,
            reachesOverBudget: fluvial.volumeBudget.reachesOverBudget,
            applied: wantVolumeConstraint,
          },
          maxOvertopRatio: Number.isFinite(overtopping.maxRatio) ? Math.round(overtopping.maxRatio * 100) / 100 : null,
          trunkBankfullM3PerS:
            trunkCell >= 0 ? Math.round(channels.capacityM3PerS[trunkCell]! * 10) / 10 : null,
          trunkCatchmentKm2: Math.round(trunkCatchmentKm2 * 10) / 10,
          externalCatchmentKm2: Math.round(externalCatchmentKm2 * 10) / 10,
          externalInflowM3: Math.round(externalInflowM3),
          dynamics: {
            enabled: wantDynamicRouting,
            arrival:
              floodWave === null
                ? null
                : {
                    earliestHours: Math.round(floodWave.summary.earliestArrivalHours * 100) / 100,
                    latestHours: Math.round(floodWave.summary.latestArrivalHours * 100) / 100,
                    trunkHours: Math.round(floodWave.summary.trunkArrivalHours * 100) / 100,
                    trunkPeakHours: Math.round(floodWave.summary.trunkPeakTimeHours * 100) / 100,
                  },
            momentum:
              floodWave === null
                ? null
                : {
                    maximumCharacteristicSpeedMPerS:
                      Math.round(floodWave.summary.maximumCharacteristicSpeedMPerS * 100) / 100,
                    maximumVelocityMPerS:
                      fluvial.hydraulics === null
                        ? null
                        : Math.round(fluvial.hydraulics.maximumVelocityMPerS * 100) / 100,
                    maximumFroudeNumber:
                      fluvial.hydraulics === null
                        ? null
                        : Math.round(fluvial.hydraulics.maximumFroudeNumber * 100) / 100,
                    maximumVelocityHeadM:
                      fluvial.hydraulics === null
                        ? null
                        : Math.round(fluvial.hydraulics.maximumMomentumHeadM * 100) / 100,
                    affectedReaches: fluvial.hydraulics?.momentumAffectedReaches ?? 0,
                    supercriticalReaches: fluvial.hydraulics?.supercriticalReaches ?? 0,
                  },
            backwater:
              !wantBackwater || fluvial.hydraulics === null
                ? null
                : {
                    affectedReaches: fluvial.hydraulics.backwaterAffectedReaches,
                    maximumRiseM:
                      Math.round(fluvial.hydraulics.maximumBackwaterRiseM * 100) / 100,
                    stageCappedReaches: fluvial.hydraulics.stageCappedReaches,
                  },
            note: wantDynamicRouting
              ? `Times are hours after storm start. Polygons show the maximum stage reached at each cell, so they are not simultaneous at those times. ${
                  wantBackwater
                    ? 'The opt-in standard-step backwater profile was applied.'
                    : 'Backwater stage propagation was not applied; it is an opt-in because it failed the four-event hindcast stop rule.'
                }`
              : 'Dynamic routing was disabled; discharge is the event volume divided by duration and reaches are solved independently.',
          },
          inlets,
        },
        climatology: {
          sourceId: CLIMATE_SOURCE_ID,
          attribution: CLIMATE_ATTRIBUTION,
          status: climate.status,
          retrievedFrom: climate.retrievedFrom,
          yearsOfRecord: climate.yearsOfRecord,
          twoYearDailyRainfallMm: climate.rain2yrMm,
          // A gauge measures a point; the storm that sets a river's bankfull
          // discharge has to cross the whole catchment, so the point value is
          // reduced to a catchment average before it is used. Quoted for the
          // main stem — every reach gets its own factor from its own area.
          arealReductionFactor: Math.round(trunkArealReduction * 1000) / 1000,
          arealReducedTwoYearRainfallMm:
            Math.round(climate.rain2yrMm * trunkArealReduction * 10) / 10,
          note: usingClimateGeometry
            ? 'Bankfull discharge is the mean annual flood implied by this rainfall, so channel capacity is grounded in local climate rather than extrapolated geometry.'
            : 'Climatology unavailable, so channel capacity falls back to area-keyed hydraulic geometry, which is known to understate large rivers badly.',
        },
        permanentWater: {
          sourceId: WATER_SOURCE_ID,
          attribution: WATER_ATTRIBUTION,
          status: wantWaterMask ? water.status : 'disabled by request',
          retrievedFrom: wantWaterMask ? (water.retrievedFrom ?? 'none') : 'none',
          waterWays: water.wayCount,
          waterRelations: water.relationCount,
          gridCellsWater: waterRaster.waterCells,
          gridCellsMasked: waterMask.maskedCells,
          areaMaskedKm2: Math.round(waterAreaInCircleKm2 * 100) / 100,
          note:
            !wantWaterMask
              ? 'Permanent-water masking was disabled by request. Reservoir geometry may still have been read for dam storage, but no lake or channel cell was removed from the reported extent.'
              : waterRaster.waterCells === 0
              ? 'No mapped standing water was excluded, so lakes, reservoirs and river channels inside the extent are reported as flooded. Absence of data is not evidence of absence of water.'
              : 'Lakes, reservoirs and river channels are excluded from the reported extent: they are already water, not land that floods. Only the mapped normal pool is removed, so flooding beyond a shoreline is still reported — and the water body itself remains dangerous in a flood.',
        },
        infrastructure: {
          sourceId: INFRASTRUCTURE_SOURCE_ID,
          attribution: INFRASTRUCTURE_ATTRIBUTION,
          status: infrastructure.status,
          retrievedFrom: infrastructure.retrievedFrom,
          truncated: infrastructure.truncated,
          dams: {
            enabled: useDams,
            mappedElements: infrastructure.damElements,
            mappedGridCells: infrastructureRaster.damCells,
            modelledSites: damRouting.sites.length,
            availableStorageDepthM: damAvailableStorageDepthM,
            retainedM3: Math.round(damRouting.retainedM3),
            sites: damRouting.sites.map((site) => ({
              ...cellLonLat(mosaic, geometry, site.cell),
              mappedStructures: site.structures,
              reservoirAreaKm2: Math.round((site.reservoirAreaM2 / 1e6) * 1000) / 1000,
              storageCapacityM3: Math.round(site.storageCapacityM3),
              inflowM3: Math.round(site.inflowM3),
              retainedM3: Math.round(site.retainedM3),
              outflowM3: Math.round(site.outflowM3),
            })),
            note:
              !useDams
                ? 'Dam attenuation was disabled by request.'
                : damRouting.sites.length === 0
                  ? 'No mapped dam could be placed on the drainage grid. Absence of mapping is not evidence of absence of dams.'
                  : 'Each mapped dam retains at most mapped upstream normal-pool area times availableStorageDepthM. Zero mapped reservoir area gives zero assumed storage rather than invented protection.',
          },
          stormSewers: {
            enabled: useStormSewers,
            mappedElements: infrastructure.drainElements,
            mappedGridCells: infrastructureRaster.drainCells,
            servedGridCells: infrastructureRaster.drainServedCells,
            serviceAreaKm2: Math.round((drainServiceAreaM2 / 1e6) * 100) / 100,
            capacityMmPerHour: stormSewerCapacityMmPerHour,
            serviceRadiusM: stormSewerServiceRadiusM,
            runoffCapturedM3: Math.round(stormDrainage.capturedM3),
            servicedWetCells: stormDrainage.servicedWetCells,
            note:
              !useStormSewers
                ? 'Storm-drainage removal was disabled by request.'
                : infrastructure.drainElements === 0
                  ? 'No mapped storm drain, sewer, drain or culvert served the grid. Underground-network coverage in OpenStreetMap is sparse; this is missing data, not evidence of no drainage.'
                  : 'Runoff is removed only from mapped served cells and cannot exceed either the water present or capacityMmPerHour over the event duration.',
          },
          buildings: {
            enabled: useBuildings,
            mappedElements: infrastructure.buildingElements,
            mappedGridCells: infrastructureRaster.buildingCells,
            footprintAreaKm2: Math.round((buildingFootprintAreaM2 / 1e6) * 100) / 100,
            depthAdjustedCells: buildingAdjustment.adjustedCells,
            maximumBlockedFraction: maximumBuildingBlockedFraction,
            maxDepthMultiplier: Math.round(buildingAdjustment.maxDepthMultiplier * 100) / 100,
            note:
              !useBuildings
                ? 'Building storage displacement was disabled by request.'
                : infrastructure.buildingElements === 0
                  ? 'No mapped building footprint affected the grid. Absence of mapping is not evidence of open ground.'
                  : 'Mapped footprint fraction displaces sub-grid flood storage and raises open-area depth; it does not claim to resolve flow around individual walls or water entry into a structure.',
          },
        },
        defences: {
          sourceId: LEVEE_SOURCE_ID,
          attribution: LEVEE_ATTRIBUTION,
          status: levees.status,
          retrievedFrom: levees.retrievedFrom ?? 'none',
          embankmentWays: levees.wayCount,
          waysWithRecordedHeight: levees.withRecordedHeight,
          gridCellsWithEmbankment: leveeRaster.leveeCells,
          cellsProtected: defended.protectedCells,
          note:
            levees.wayCount === 0
              ? 'No mapped embankments were used, so the floodplain is treated as undefended. Absence of data is not evidence of absence of levees.'
              : 'Mapped embankments block river inundation unless overtopped or breached. Coverage is uneven; compare embankmentWays between areas before comparing their results.',
        },
        /**
         * `cell` is an index into a mosaic the caller never sees, so a breach
         * was previously unplaceable on a map. The coordinates are the useful
         * part of a breach — where the levee is predicted to fail.
         */
        breaches: breaches.map((site) => ({ ...site, ...cellLonLat(mosaic, geometry, site.cell) })),
        inundation: {
          // p99 is the figure to quote: a single unresolved gorge can leave one
          // artifact cell tens of metres deep and it would own the maximum.
          p99DepthMetres: summary.p99DepthMetres,
          maxDepthMetres: summary.maxDepthMetres,
          meanDepthMetres: summary.meanDepthMetres,
          floodedAreaKm2: summary.floodedAreaKm2,
          volume: {
            rainfallRunoffM3: Math.round(rainfallRunoffM3),
            stormSewerCapturedM3: Math.round(stormDrainage.capturedM3),
            surfaceRunoffM3: Math.round(rainfallRunoffM3 - stormDrainage.capturedM3),
            channelInflowM3: Math.round(externalInflowM3),
            totalIntroducedM3: Math.round(coupled.totalRunoffM3),
            pondedM3: Math.round(coupled.storedM3),
            conveyedByChannelsM3: Math.round(coupled.conveyedM3),
            drainedM3: Math.round(coupled.outflowM3),
          },
          depressionCount: coupled.depressionCount,
          overflowingCount: coupled.overflowingCount,
          oceanCellsMasked: coupled.oceanCellCount,
          attribution: {
            pluvialOnlyAreaKm2: pluvialSummary.floodedAreaKm2,
            pluvialOnlyP99DepthMetres: pluvialSummary.p99DepthMetres,
            fluvialOnlyAreaKm2: fluvialSummary.floodedAreaKm2,
            fluvialOnlyP99DepthMetres: fluvialSummary.p99DepthMetres,
            fluvialUndefendedAreaKm2: undefendedSummary.floodedAreaKm2,
            leveeProtectedAreaKm2:
              Math.round((undefendedSummary.floodedAreaKm2 - fluvialSummary.floodedAreaKm2) * 1000) / 1000,
            fluvialDeltaAreaKm2:
              Math.round((summary.floodedAreaKm2 - pluvialSummary.floodedAreaKm2) * 1000) / 1000,
            note: 'pluvialOnly* is rain ponding in closed depressions; fluvialOnly* is river stage mapped by HAND. The reported extent is the deeper of the two per cell, so the two parts do not sum.',
            ...(componentZones
              ? {
                  pluvialZones: componentZones.pluvial,
                  fluvialZones: componentZones.fluvial,
                  fluvialPeggedZones: componentZones.fluvialPegged,
                }
              : {}),
          },
          zones,
        },
        provenance,
        timingsMs,
        limitations: LIMITATIONS,
      }

      const rawText = JSON.stringify(response)
      // Do not pin a best-effort partial infrastructure layer in the whole-model
      // cache. The source keeps completed child boxes on disk, so a later request
      // can resume and replace it with a complete result. Fixture responses and
      // deliberately disabled infrastructure are deterministic and remain safe
      // to cache.
      if (fixtureMode || !wantInfrastructure || (infrastructure.status === 'ok' && !infrastructure.truncated)) {
        proxy.setCache(cacheKey, response, rawText, 200, 'application/json')
      }
      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(rawText, 200, { 'content-type': 'application/json' })
    } catch (err: unknown) {
      if (err instanceof PrecipitationUnavailable) {
        return c.json({ error: 'UpstreamFailed', message: err.message }, 502)
      }
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  return router
}
