import { Effect } from 'effect'
import { disasterToolSet } from '../src/toolsets/disaster'
import type { ToolExecutionContext } from '../src/domain/tool'

const mockCtx: ToolExecutionContext = {
  signal: new AbortController().signal,
  toolCallId: 'test_call_1',
}

const findTool = (name: string) => {
  const tool = disasterToolSet.tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found in disasterToolSet`)
  return tool
}

async function main() {
  console.log('\n======================================================')
  console.log('🧪 Testing Core WebMCP Functions (Live Cloudflare Backend)')
  console.log('======================================================\n')

  let searchCoords = { latitude: 35.681236, longitude: 139.767125 }

  // 1. Search Location (disaster.geocode)
  console.log('--- [1/3] Testing: search location (disaster.geocode) ---')
  const geocodeTool = findTool('disaster.geocode')
  try {
    const geocodeResult = await Effect.runPromise(
      geocodeTool.execute({ query: 'Tokyo Station', limit: 3 }, mockCtx)
    )
    console.log('Status: SUCCESS')
    console.log('Result payload:\n', JSON.stringify(geocodeResult, null, 2))

    // Extract first coordinate if available
    const parsed = typeof geocodeResult === 'object' && geocodeResult !== null ? geocodeResult as any : {}
    if (parsed.candidates && parsed.candidates.length > 0) {
      searchCoords = {
        latitude: parsed.candidates[0].latitude,
        longitude: parsed.candidates[0].longitude,
      }
      console.log(`\nSelected coordinates for subsequent tests: [Lat: ${searchCoords.latitude}, Lon: ${searchCoords.longitude}]`)
    }
  } catch (err: any) {
    console.error('❌ disaster.geocode failed:', err)
  }

  // 2. Find Shelters (disaster.find_shelters)
  console.log('\n--- [2/3] Testing: find shelter (disaster.find_shelters) ---')
  const sheltersTool = findTool('disaster.find_shelters')
  try {
    const sheltersResult = await Effect.runPromise(
      sheltersTool.execute({
        latitude: searchCoords.latitude,
        longitude: searchCoords.longitude,
        radiusKm: 3,
        limit: 5,
      }, mockCtx)
    )
    console.log('Status: SUCCESS')
    console.log('Result payload:\n', JSON.stringify(sheltersResult, null, 2))
  } catch (err: any) {
    console.error('❌ disaster.find_shelters failed:', err)
  }

  // 3. Routing (disaster.evacuation_routes)
  console.log('\n--- [3/3] Testing: routing (disaster.evacuation_routes) ---')
  const routesTool = findTool('disaster.evacuation_routes')
  try {
    const routesResult = await Effect.runPromise(
      routesTool.execute({
        latitude: searchCoords.latitude,
        longitude: searchCoords.longitude,
        radiusKm: 3,
        mode: 'walk',
        limit: 2,
      }, mockCtx)
    )
    console.log('Status: SUCCESS')
    console.log('Result payload:\n', JSON.stringify(routesResult, null, 2))
  } catch (err: any) {
    console.error('❌ disaster.evacuation_routes failed:', err)
  }

  console.log('\n======================================================')
  console.log('🎉 Core Functions Test Finished')
  console.log('======================================================\n')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
