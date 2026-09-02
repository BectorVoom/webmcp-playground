/**
 * Resume one disk-cached OSM flood-infrastructure bounding box.
 *
 * Usage:
 *   bun tools/warm-infrastructure.ts <minLon> <minLat> <maxLon> <maxLat> [...]
 *
 * This intentionally imports no climate, terrain, or flood-route code. It is a
 * narrow recovery tool for capped or interrupted Overpass subdivisions.
 */
import { Effect } from 'effect'
import type { BBox } from '../src/domain/geo'
import { loadConfig } from '../server/config'
import { GeoProxyService } from '../server/geo-proxy'
import { loadInfrastructure } from '../server/infrastructure-source'

const usage = 'usage: bun tools/warm-infrastructure.ts <minLon> <minLat> <maxLon> <maxLat> [...]'
const values = process.argv.slice(2).map(Number)
if (values.length < 4 || values.length % 4 !== 0 || values.some((value) => !Number.isFinite(value))) {
  throw new Error(usage)
}

const bboxes: BBox[] = []
for (let index = 0; index < values.length; index += 4) {
  const bbox = values.slice(index, index + 4) as unknown as BBox
  const [minLon, minLat, maxLon, maxLat] = bbox
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 || minLon >= maxLon || minLat >= maxLat) {
    throw new Error(`${usage}; received an invalid WGS84 bbox`)
  }
  bboxes.push(bbox)
}

const config = Effect.runSync(loadConfig(process.env))
const proxy = new GeoProxyService(config)
let failed = false
for (const bbox of bboxes) {
  const result = await loadInfrastructure(proxy, bbox, false, { cacheDir: config.waterCacheDir })

  console.log(JSON.stringify({
    bbox,
    status: result.status,
    truncated: result.truncated,
    retrievedFrom: result.retrievedFrom,
    dams: result.damElements,
    drains: result.drainElements,
    buildings: result.buildingElements,
  }))
  failed ||= result.truncated || result.retrievedFrom === 'none'
}

if (failed) process.exitCode = 2
