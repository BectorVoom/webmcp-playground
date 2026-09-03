import { Effect } from 'effect'
import { disasterToolSet } from '../src/toolsets/disaster'
import type { ToolExecutionContext } from '../src/domain/tool'

const mockCtx: ToolExecutionContext = {
  signal: new AbortController().signal,
  toolCallId: 'test_flood_1',
}

const findTool = (name: string) => {
  const tool = disasterToolSet.tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found in disasterToolSet`)
  return tool
}

async function testRegionFlood(regionLabel: string, placeName: string, coords: { latitude: number; longitude: number }) {
  console.log(`\n======================================================================`)
  console.log(`🌊 TESTING FLOOD ALERTS & FLOOD ZONES: ${regionLabel.toUpperCase()}`)
  console.log(`Location: ${placeName} (${coords.latitude}, ${coords.longitude})`)
  console.log(`======================================================================`)

  const alertsTool = findTool('disaster.official_alerts')
  const floodTool = findTool('disaster.flood_forecast')

  // 1. Official Alerts
  console.log(`\n--- [1/2] ${regionLabel}: Official Alerts (disaster.official_alerts) ---`)
  try {
    const alertsRes = await Effect.runPromise(
      alertsTool.execute({
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusKm: 15,
        limit: 5,
      }, mockCtx)
    )
    console.log('✅ Alerts Status: SUCCESS')
    const text = (alertsRes as any)?.content?.[0]?.text ?? JSON.stringify(alertsRes)
    console.log(text)
  } catch (err: any) {
    console.error(`❌ ${regionLabel} Official Alerts Error:`, err.message ?? err)
  }

  // 2. Flood Forecast & Flood Zones
  console.log(`\n--- [2/2] ${regionLabel}: Flood Forecast & Hazard Zones (disaster.flood_forecast) ---`)
  try {
    const floodRes = await Effect.runPromise(
      floodTool.execute({
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusKm: 10,
        horizonHours: 24,
      }, mockCtx)
    )
    console.log('✅ Flood Forecast Status: SUCCESS')
    const text = (floodRes as any)?.content?.[0]?.text ?? JSON.stringify(floodRes)
    console.log(text)
  } catch (err: any) {
    console.error(`❌ ${regionLabel} Flood Forecast Error:`, err.message ?? err)
  }
}

async function main() {
  // Test EU: Cologne, Germany
  await testRegionFlood('Europe (EU)', 'Cologne, Germany', { latitude: 50.9413, longitude: 6.9581 })

  // Test America (US): Houston, Texas
  await testRegionFlood('America (US)', 'Houston, Texas', { latitude: 29.7602, longitude: -95.3694 })

  console.log('\n======================================================================')
  console.log('🎉 FLOOD ALERTS & FLOOD ZONES TESTS COMPLETED')
  console.log('======================================================================\n')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
