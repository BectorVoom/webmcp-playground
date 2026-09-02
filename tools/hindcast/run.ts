/**
 * Hindcast harness CLI.
 *
 *   bun tools/hindcast/run.ts fetch                 # observed extents, verified
 *   bun tools/hindcast/run.ts score [config...]     # score named configs
 *   bun tools/hindcast/run.ts profile               # decompose the error
 *
 * Needs a live server: GEO_DATA_MODE=live PORT=8899 bun run server/index.ts
 */
import { EVENTS, eventById } from './events'
import { fetchObserved, loadObserved, type Observed } from './observed'
import { runModel, warmClimatology, type ModelConfig } from './model'
import { buildLattice, scoreRun, percent, meanOf, type Lattice, type Score } from './score'

/** The configurations round seven measured, kept so its table can be re-run. */
export const CONFIGS: Record<string, ModelConfig> = {
  baseline: {},
  /** Round eleven's event-average, independent-reach model, before dynamics. */
  steady: { dynamicRouting: false },
  /**
   * Matched dynamics experiment. Infrastructure is held off because its OSM
   * coverage is not complete at three Japanese sites; every hydraulic and
   * terrain input remains identical between the two arms.
   */
  'hydraulic-steady': {
    dynamicRouting: false,
    useDams: false,
    useStormSewers: false,
    useBuildings: false,
  },
  'hydraulic-timing': {
    dynamicRouting: true,
    backwater: false,
    useDams: false,
    useStormSewers: false,
    useBuildings: false,
  },
  'hydraulic-dynamic': {
    dynamicRouting: true,
    backwater: true,
    useDams: false,
    useStormSewers: false,
    useBuildings: false,
  },
  /**
   * The single-section rating curve, which is what every figure recorded before
   * round eight was measured with. Kept as a config so those figures stay
   * reproducible rather than merely remembered. Smoothing is pinned off because
   * it postdates every one of those figures, and so does the water mask.
   */
  single: {
    floodplainManningN: 0.035,
    stageSmoothingM: 0,
    maskPermanentWater: false,
    dynamicRouting: false,
  },
  /**
   * Round eight's shipped default — the compound curve with the raw per-reach
   * stage field. What `baseline` meant before round nine made smoothing the
   * default; kept so round eight's table stays reproducible.
   */
  unsmoothed: { stageSmoothingM: 0, maskPermanentWater: false, dynamicRouting: false },
  A: { volumeConstraint: true },
  B: { stageDischarge: 'excess' },
  C: { arealReduction: true },
  AB: { volumeConstraint: true, stageDischarge: 'excess' },
  AC: { volumeConstraint: true, arealReduction: true },
  BC: { stageDischarge: 'excess', arealReduction: true },
  ABC: { volumeConstraint: true, stageDischarge: 'excess', arealReduction: true },
  /**
   * Floodplain roughness. The rating curve applies one Manning n to the channel
   * and to the floodplain alike, and 0.035 is a clean channel — a vegetated or
   * built-up floodplain is 0.06-0.15. Too smooth a floodplain conveys too much,
   * so the curve is satisfied at too low a stage. Sweeping n is the cheapest
   * test of whether that is why the solved stage sits so far below the best
   * uniform one.
   */
  n060: { manningN: 0.06 },
  n100: { manningN: 0.1 },
  n150: { manningN: 0.15 },
  /**
   * The compound rating curve those sweeps motivated: the channel keeps 0.035
   * and only the floodplain roughens. `composite` blends the two roughnesses
   * over the wetted perimeter; `divided` sums two conveyances, which adds
   * conveyance by splitting and works against the roughness it is applying.
   */
  fp060: { floodplainManningN: 0.06 },
  fp080: { floodplainManningN: 0.08 },
  fp100: { floodplainManningN: 0.1 },
  fp150: { floodplainManningN: 0.15 },
  fp200: { floodplainManningN: 0.2 },
  'fp100-divided': { floodplainManningN: 0.1, compoundMethod: 'divided' },
  'fp200-divided': { floodplainManningN: 0.2, compoundMethod: 'divided' },
  fp250: { floodplainManningN: 0.25 },
  fp300: { floodplainManningN: 0.3 },
  'fp150-divided': { floodplainManningN: 0.15, compoundMethod: 'divided' },
  'fp250-divided': { floodplainManningN: 0.25, compoundMethod: 'divided' },
  'fp300-divided': { floodplainManningN: 0.3, compoundMethod: 'divided' },
  /**
   * Along-channel stage smoothing (round nine). Each reach solves its rating
   * curve from only the strip of cells that happen to drain to it, and the
   * ceiling sweep showed the resulting field carries more noise than signal on
   * flat floodplains — a constant stage beats it at three of four sites. The
   * window is the same idea as SLOPE_REACH_METRES: average away what one cell
   * cannot measure. Pegged reaches borrow their neighbours' consensus.
   */
  sm025: { stageSmoothingM: 250 },
  sm05: { stageSmoothingM: 500 },
  sm1: { stageSmoothingM: 1000 },
  sm2: { stageSmoothingM: 2000 },
  sm4: { stageSmoothingM: 4000 },
  sm8: { stageSmoothingM: 8000 },
  /**
   * Round ten — the DEM itself, which every previous round's ceiling pointed at
   * without ever testing. Three arms that separate the two things a better DEM
   * changes, because conflating them is how "we need better data" stays an
   * opinion:
   *
   *   baseline   terrarium z11, ~62 m   the shipped default
   *   demz12     terrarium z12, ~31 m   finer grid, *same* SRTM information
   *   gsi10      GSI DEM10B,   ~31 m    same grid, Japan's national 10 m survey
   *
   * `demz12` against `baseline` prices resolution alone; `gsi10` against
   * `demz12` prices the terrain information, at matched cell size. z12 is where
   * both land because the 20 km circle's grid budget degrades anything finer,
   * so the two are compared on identical geometry rather than merely similar.
   */
  demz12: { demZoom: 12, dynamicRouting: false },
  gsi10: { demSource: 'gsi10', dynamicRouting: false },
  /**
   * Round eleven: standing water excluded from the reported extent. `nowater`
   * pins the old behaviour so every figure recorded before it stays
   * reproducible, exactly as `single` and `unsmoothed` do for the stage work.
   */
  'gsi10-nowater': { demSource: 'gsi10', maskPermanentWater: false, dynamicRouting: false },
  'baseline-nowater': { maskPermanentWater: false, dynamicRouting: false },
  'gsi10-unsmoothed': { demSource: 'gsi10', stageSmoothingM: 0, dynamicRouting: false },
  /**
   * Round twelve: floodplain roughness re-examined against the official
   * envelope. Round eight picked 0.10 from Chow's table because sweeping it
   * against the *event* survey produced no interior optimum — but that metric is
   * now known to be bounded near 25% for any envelope product, so the sweep it
   * rejected was run against the wrong reference.
   */
  'gsi10-fp15': { demSource: 'gsi10', floodplainManningN: 0.15, dynamicRouting: false },
  'gsi10-fp20': { demSource: 'gsi10', floodplainManningN: 0.2, dynamicRouting: false },
  'gsi10-fp30': { demSource: 'gsi10', floodplainManningN: 0.3, dynamicRouting: false },
}

/**
 * Figures a config is expected to reproduce, for the drift check.
 *
 * Each entry pins one shipped default, and the older ones are reached by
 * turning off whatever shipped after them: `single` is rounds two to seven
 * (plan-stage-reconciliation.md §1a), `unsmoothed` is round eight
 * (plan-precision-profile.md §7), `baseline-nowater` is round nine's smoothed
 * default (plan-stage-smoothing.md §5), and `steady` is round eleven's, with
 * standing water excluded. `baseline` is the current dynamic model.
 *
 * `demz12`, `gsi10` and `gsi10-nowater` are round ten's DEM arms; they need the
 * tile store warmed and DEM_CACHE_DIR set, or the route re-asks GSI per tile.
 */
const EXPECTED_IOU: Record<string, Record<string, number>> = {
  single: { joso: 0.163, mabi: 0.161, nagano: 0.107, kuma: 0.24 },
  unsmoothed: { joso: 0.171, mabi: 0.181, nagano: 0.11, kuma: 0.266 },
  'baseline-nowater': { joso: 0.233, mabi: 0.259, nagano: 0.112, kuma: 0.281 },
  steady: { joso: 0.24, mabi: 0.281, nagano: 0.12, kuma: 0.314 },
  demz12: { joso: 0.217, mabi: 0.301, nagano: 0.124, kuma: 0.267 },
  'gsi10-nowater': { joso: 0.261, mabi: 0.328, nagano: 0.085, kuma: 0.302 },
  gsi10: { joso: 0.268, mabi: 0.35, nagano: 0.095, kuma: 0.337 },
}

export const loadAll = async (ids?: ReadonlyArray<string>): Promise<ReadonlyArray<Observed>> => {
  const events = ids?.length ? ids.map(eventById) : EVENTS
  return Promise.all(events.map(loadObserved))
}

export const latticesFor = (sites: ReadonlyArray<Observed>): Map<string, Lattice> =>
  new Map(sites.map((site) => [site.event.id, buildLattice(site)]))

const scoreConfig = async (
  sites: ReadonlyArray<Observed>,
  lattices: Map<string, Lattice>,
  config: ModelConfig,
): Promise<Map<string, { score: Score; polyGridRatio: number; areaKm2: number }>> => {
  const results = new Map<string, { score: Score; polyGridRatio: number; areaKm2: number }>()
  for (const site of sites) {
    const run = await runModel(site, config)
    const score = scoreRun(lattices.get(site.event.id)!, run)
    results.set(site.event.id, {
      score,
      polyGridRatio: run.polyGridRatio,
      areaKm2: run.floodedAreaKm2,
    })
  }
  return results
}

const main = async (): Promise<void> => {
  const [command = 'score', ...rest] = process.argv.slice(2)

  if (command === 'fetch') {
    await fetchObserved()
    for (const site of await loadAll()) {
      console.log(
        `${site.event.id.padEnd(8)} ${site.areaKm2.toFixed(1)} km²  ` +
          `${site.polygons.length} polygons  centre ` +
          `${site.centre.latitude.toFixed(4)}, ${site.centre.longitude.toFixed(4)}` +
          (site.failurePoints.length ? `  ${site.failurePoints.length} surveyed failure points` : ''),
      )
    }
    return
  }

  const requestedEvents = process.env.HINDCAST_EVENTS
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const sites = await loadAll(requestedEvents)
  const lattices = latticesFor(sites)
  for (const site of sites) {
    const lattice = lattices.get(site.event.id)!
    const wet = lattice.observed.reduce((sum, v) => sum + v, 0)
    console.log(
      `${site.event.id.padEnd(8)} lattice ${lattice.points.length} pts, ${wet} observed wet ` +
        `(${(wet * 0.01).toFixed(1)} km² vs ${site.areaKm2.toFixed(1)} km² polygon)`,
    )
  }

  await warmClimatology(sites)

  const names = rest.length ? rest : ['baseline']
  console.log('\n| Config | Event | IoU | POD | Precision | model km² | ratio | poly/grid |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const name of names) {
    const config = CONFIGS[name]
    if (!config) throw new Error(`unknown config: ${name} (have ${Object.keys(CONFIGS).join(', ')})`)
    const results = await scoreConfig(sites, lattices, config)
    const ious: Array<number> = []
    const pods: Array<number> = []
    const precisions: Array<number> = []
    for (const site of sites) {
      const { score, polyGridRatio, areaKm2 } = results.get(site.event.id)!
      ious.push(score.iou)
      pods.push(score.pod)
      precisions.push(score.precision)
      const expected = EXPECTED_IOU[name]?.[site.event.id]
      const drift = expected === undefined ? '' : ` (expected ${percent(expected)})`
      console.log(
        `| ${name} | ${site.event.label} | ${percent(score.iou)}${drift} | ${percent(score.pod)} | ` +
          `${percent(score.precision)} | ${areaKm2.toFixed(1)} | ` +
          `${score.overPredictionRatio.toFixed(1)}× | ${polyGridRatio.toFixed(2)}× |`,
      )
    }
    console.log(
      `| **${name}** | **mean** | **${percent(meanOf(ious))}** | **${percent(meanOf(pods))}** | ` +
        `**${percent(meanOf(precisions))}** | | | |`,
    )
  }
}

if (import.meta.main) {
  await main()
}
