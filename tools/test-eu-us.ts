import { Effect } from 'effect'
import { disasterToolSet } from '../src/toolsets/disaster'
import type { ToolExecutionContext } from '../src/domain/tool'

const mockCtx: ToolExecutionContext = {
  signal: new AbortController().signal,
  toolCallId: 'test_eu_us_1',
}

const findTool = (name: string) => {
  const tool = disasterToolSet.tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found in disasterToolSet`)
  return tool
}

async function runRegionTest(regionName: string, queryName: string, defaultCoords: { latitude: number; longitude: number }) {
  console.log(`\n======================================================================`)
  console.log(`🌍 TESTING REGION: ${regionName.toUpperCase()}`)
  console.log(`======================================================================`)

  const geocodeTool = findTool('disaster.geocode')
  const sheltersTool = findTool('disaster.find_shelters')
  const routesTool = findTool('disaster.evacuation_routes')

  let coords = defaultCoords

  // 1. Search Location (disaster.geocode)
  console.log(`\n--- [1/3] ${regionName}: Search Location ("${queryName}") ---`)
  try {
    const res = await Effect.runPromise(
      geocodeTool.execute({ query: queryName, limit: 3 }, mockCtx)
    )
    console.log('✅ Geocode Status: SUCCESS')
    const text = (res as any)?.content?.[0]?.text ?? JSON.stringify(res)
    console.log(text)

    const parsed = typeof res === 'object' && res !== null ? res as any : {}
    if (parsed.candidates && parsed.candidates.length > 0) {
      coords = {
        latitude: parsed.candidates[0].latitude,
        longitude: parsed.candidates[0].longitude,
      }
      console.log(`\nUsing geocoded coordinate: [Lat: ${coords.latitude}, Lon: ${coords.longitude}]`)
    }
  } catch (err: any) {
    console.error(`❌ [1/3] ${regionName} Geocode Error:`, err.message ?? err)
  }

  // 2. Find Shelters (disaster.find_shelters)
  console.log(`\n--- [2/3] ${regionName}: Find Shelters around [${coords.latitude}, ${coords.longitude}] ---`)
  try {
    const res = await Effect.runPromise(
      sheltersTool.execute({
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusKm: 5,
        limit: 5,
      }, mockCtx)
    )
    console.log('✅ Find Shelters Status: SUCCESS')
    const text = (res as any)?.content?.[0]?.text ?? JSON.stringify(res)
    console.log(text)
  } catch (err: any) {
    console.error(`❌ [2/3] ${regionName} Find Shelters Error:`, err.message ?? err)
  }

  // 3. Routing (disaster.evacuation_routes)
  console.log(`\n--- [3/3] ${regionName}: Plan Evacuation Route from [${coords.latitude}, ${coords.longitude}] ---`)
  try {
    const res = await Effect.runPromise(
      routesTool.execute({
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusKm: 5,
        mode: 'walk',
        limit: 3,
      }, mockCtx)
    )
    console.log('✅ Routing Status: SUCCESS')
    const text = (res as any)?.content?.[0]?.text ?? JSON.stringify(res)
    console.log(text)
  } catch (err: any) {
    console.error(`❌ [3/3] ${regionName} Routing Error:`, err.message ?? err)
  }
}

async function main() {
  // Test EU: Cologne Cathedral, Germany
  await runRegionTest('Europe (EU)', 'Cologne Cathedral', { latitude: 50.9413, longitude: 6.9583 })

  // Test America (US): Houston City Hall, Texas
  await runRegionTest('America (US)', 'Houston City Hall', { latitude: 29.7604, longitude: -95.3698 })

  console.log('\n======================================================================')
  console.log('🎉 ALL EU & AMERICA REGIONAL TESTS COMPLETED')
  console.log('======================================================================\n')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
