/**
 * Does the model fail the levee where the levee actually failed?
 *
 * GSI's Joso archive is the one reference here that records the survey's own
 * 破堤箇所 and 越水箇所 — the breach and overtopping points. The specs argue the
 * remaining error is irreducible without knowing which levee failed; the model
 * does predict failures, so this asks how close its guesses land.
 *
 *   bun tools/hindcast/breach-check.ts
 */
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'

const METRES_PER_DEGREE = 111_320

const distanceM = (
  a: { longitude: number; latitude: number },
  b: { longitude: number; latitude: number },
): number => {
  const dy = (a.latitude - b.latitude) * METRES_PER_DEGREE
  const dx =
    (a.longitude - b.longitude) * METRES_PER_DEGREE * Math.cos((a.latitude * Math.PI) / 180)
  return Math.hypot(dx, dy)
}

interface PredictedBreach {
  readonly longitude: number
  readonly latitude: number
  readonly overtopRatio: number
  readonly dischargeM3PerS: number
}

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  await warmClimatology(sites)

  for (const site of sites) {
    const run = await runModel(site, {})
    const predicted = (run.response.breaches ?? []) as ReadonlyArray<PredictedBreach>
    const surveyed = site.failurePoints
    console.log(`\n## ${site.event.label}`)
    if (surveyed.length === 0) {
      console.log(`  survey records no failure points; model predicted ${predicted.length}`)
      continue
    }
    for (const point of surveyed) {
      const distances = predicted.map((p) => distanceM(p, point))
      const nearest = Math.min(...distances)
      console.log(
        `  surveyed ${point.kind} at ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)} — ` +
          `nearest of ${predicted.length} predicted breaches is ${(nearest / 1000).toFixed(2)} km away ` +
          `(all: ${distances.map((d) => (d / 1000).toFixed(2)).join(', ')} km)`,
      )
    }
  }
}

if (import.meta.main) {
  await main()
}
