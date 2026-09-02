/**
 * What storm does the official envelope actually correspond to?
 *
 * Round eleven left Nagano trailing, and the shape of the deficit changed once
 * standing water was masked: its *precision* against the envelope is now second
 * best of the four sites, while its *hit rate* is far the worst at 38.7%. So
 * Nagano is not putting water in the wrong places — it is not putting enough
 * water anywhere.
 *
 * Before attributing that to the model, check the comparison. Japan's
 * 洪水浸水想定区域 is drawn for the **L2 storm** (想定最大規模, the maximum
 * assumed scale), which is far larger than any of the four events these runs are
 * driven with. Scoring an actual-event run against a maximum-assumed-scale
 * envelope must under-predict, and by more where the actual storm fell further
 * below L2. Across the four sites hit rate already tracks storm depth in exactly
 * that order — 490 mm gives 85%, 197 mm gives 39% — which is the signature of a
 * mis-specified comparison rather than a defective site.
 *
 * Sweeping the driving rainfall separates the two. If the gap is the storm, hit
 * rate climbs toward the other sites and precision holds as the extent grows —
 * the envelope is simply being approached. If the model is wrong at Nagano,
 * precision falls away as extent grows and no rainfall recovers it.
 *
 *   bun tools/hindcast/storm-sweep.ts [event...]
 */
import { eventById, EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, scoreRun, percent, type Lattice } from './score'
import { loadHazardMask, type HazardMask } from './hazard'

const RAINFALL_MM = [150, 200, 300, 400, 500, 600, 800] as const

interface Row {
  readonly rainfallMm: number
  readonly podEnvelope: number
  readonly precisionEnvelope: number
  readonly iouEnvelope: number
  readonly podEvent: number
  readonly precisionEvent: number
  readonly modelKm2: number
}

const confuse = (predicted: Uint8Array, truth: Uint8Array) => {
  let tp = 0
  let fp = 0
  let fn = 0
  for (let i = 0; i < predicted.length; i++) {
    const wet = predicted[i] === 1
    const real = truth[i] === 1
    if (wet && real) tp++
    else if (wet) fp++
    else if (real) fn++
  }
  return {
    iou: tp / (tp + fp + fn || 1),
    pod: tp / (tp + fn || 1),
    precision: tp / (tp + fp || 1),
  }
}

const main = async (): Promise<void> => {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['nagano', 'joso']
  const sites = await Promise.all(ids.map((id) => loadObserved(eventById(id))))
  await warmClimatology(sites)

  console.log('# What storm does the official envelope correspond to?\n')
  console.log(
    'Driving rainfall swept at a fixed duration (the event\'s own), scored against the\n' +
      'L2 envelope and against the surveyed event extent, on the national DEM with\n' +
      'standing water masked.\n',
  )

  for (const site of sites) {
    const lattice: Lattice = buildLattice(site)
    const hazard: HazardMask = await loadHazardMask(lattice.points)
    const rows: Array<Row> = []

    for (const rainfallMm of RAINFALL_MM) {
      const run = await runModel(site, { demSource: 'gsi10', rainfallMm })
      const scored = scoreRun(lattice, run)
      const wet = Uint8Array.from(scored.classAt, (cls) => (cls === '' ? 0 : 1))
      const vsEnvelope = confuse(wet, hazard.wet)
      const vsEvent = confuse(wet, lattice.observed)
      rows.push({
        rainfallMm,
        podEnvelope: vsEnvelope.pod,
        precisionEnvelope: vsEnvelope.precision,
        iouEnvelope: vsEnvelope.iou,
        podEvent: vsEvent.pod,
        precisionEvent: vsEvent.precision,
        modelKm2: run.floodedAreaKm2,
      })
    }

    console.log(
      `## ${site.event.label} — actual storm ${site.event.rainfallMm} mm / ${site.event.durationHours} h\n`,
    )
    console.log('| rainfall | POD vs env | prec vs env | IoU vs env | POD vs event | prec vs event | model km² |')
    console.log('|---|---|---|---|---|---|---|')
    for (const row of rows) {
      const mark = row.rainfallMm === Math.round(site.event.rainfallMm) ? ' *(actual)*' : ''
      console.log(
        `| ${row.rainfallMm} mm${mark} | ${percent(row.podEnvelope)} | ${percent(row.precisionEnvelope)} | ` +
          `${percent(row.iouEnvelope)} | ${percent(row.podEvent)} | ${percent(row.precisionEvent)} | ` +
          `${row.modelKm2.toFixed(0)} |`,
      )
    }
    const best = rows.reduce((a, b) => (b.iouEnvelope > a.iouEnvelope ? b : a))
    console.log(
      `\nBest IoU against the envelope at **${best.rainfallMm} mm** ` +
        `(${percent(best.iouEnvelope)}, POD ${percent(best.podEnvelope)}, ` +
        `precision ${percent(best.precisionEnvelope)}).\n`,
    )

    /**
     * If rainfall saturates, the rating curve is not the binding constraint and
     * the question becomes what the terrain will accept at all. `uniformStageM`
     * stands every reach at one height and skips the curve entirely, so a sweep
     * of it bounds the extent HAND can produce here with the stage chosen freely
     * — the same instrument round eight used, pointed at the envelope.
     */
    console.log(`### Ceiling: every reach stood at one height, ${site.event.id}\n`)
    console.log('| uniform stage | POD vs env | prec vs env | IoU vs env | model km² |')
    console.log('|---|---|---|---|---|')
    for (const uniformStageM of [2, 4, 7, 10, 15]) {
      const run = await runModel(site, { demSource: 'gsi10', uniformStageM })
      const scored = scoreRun(lattice, run)
      const wet = Uint8Array.from(scored.classAt, (cls) => (cls === '' ? 0 : 1))
      const c = confuse(wet, hazard.wet)
      console.log(
        `| ${uniformStageM} m | ${percent(c.pod)} | ${percent(c.precision)} | ${percent(c.iou)} | ` +
          `${run.floodedAreaKm2.toFixed(0)} |`,
      )
    }
    console.log()

    /**
     * The physical lever on solved stage. A rougher floodplain conveys less, so
     * the curve is satisfied higher up; round eight took 0.10 from Chow's table
     * because the four events could not identify a value. If Nagano's shortfall
     * is the curve rather than the storm, this is where it shows.
     */
    console.log(`### Floodplain roughness against the envelope, ${site.event.id}\n`)
    console.log('| n floodplain | POD vs env | prec vs env | IoU vs env | model km² |')
    console.log('|---|---|---|---|---|')
    for (const floodplainManningN of [0.1, 0.15, 0.2, 0.3]) {
      const run = await runModel(site, { demSource: 'gsi10', floodplainManningN })
      const scored = scoreRun(lattice, run)
      const wet = Uint8Array.from(scored.classAt, (cls) => (cls === '' ? 0 : 1))
      const c = confuse(wet, hazard.wet)
      console.log(
        `| ${floodplainManningN} | ${percent(c.pod)} | ${percent(c.precision)} | ${percent(c.iou)} | ` +
          `${run.floodedAreaKm2.toFixed(0)} |`,
      )
    }
    console.log()
  }

  void EVENTS
}

if (import.meta.main) {
  await main()
}
