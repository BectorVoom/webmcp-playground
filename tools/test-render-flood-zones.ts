import { spawn } from 'bun'
import fixture from '../src/adapters/map/__fixtures__/inundation-zones.json'
import { HAZARD_PALETTE } from '../src/lib/hazard-palette'

interface FixtureSite {
  readonly region: string
  readonly id: string
  readonly label: string
  readonly floodedAreaKm2: number
  readonly zones: ReadonlyArray<any>
}

const SITES = (fixture as { sites: ReadonlyArray<FixtureSite> }).sites

async function main() {
  console.log('\n======================================================================')
  console.log('🗺️ TESTING FLOOD ZONE RENDERING: EUROPE (EU) & AMERICA (US)')
  console.log('Adhering to MapLibre GL JS Frontend Testing Guidelines §4.1')
  console.log('======================================================================\n')

  const euSite = SITES.find((s) => s.region === 'EU' || s.id.includes('carlisle')) || SITES[0]!
  const usSite = SITES.find((s) => s.region === 'US' || s.id.includes('cedar-rapids')) || SITES[1]!

  console.log(`[1/2] 🇪🇺 Europe (EU) - ${euSite.label} (${euSite.id}):`)
  console.log(`      - Flooded Area Modelled: ${euSite.floodedAreaKm2.toFixed(2)} km²`)
  console.log(`      - MultiPolygon Bands: ${euSite.zones.length} depth hazard zones`)
  for (const z of euSite.zones) {
    console.log(`        * Zone [${z.hazardClass.toUpperCase()}]: ${z.depthLabel ?? z.hazardClass} | Disjoint parts: ${z.geometry.coordinates.length}`)
  }

  console.log(`\n[2/2] 🇺🇸 America (US) - ${usSite.label} (${usSite.id}):`)
  console.log(`      - Flooded Area Modelled: ${usSite.floodedAreaKm2.toFixed(2)} km²`)
  console.log(`      - MultiPolygon Bands: ${usSite.zones.length} depth hazard zones`)
  for (const z of usSite.zones) {
    console.log(`        * Zone [${z.hazardClass.toUpperCase()}]: ${z.depthLabel ?? z.hazardClass} | Disjoint parts: ${z.geometry.coordinates.length}`)
  }

  console.log('\n🎨 Hazard Palette & Accessible Texture Symbology:')
  for (const style of HAZARD_PALETTE) {
    console.log(`   - ${style.label.padEnd(10)} (${style.depthLabel}): Fill ${style.fill}, Outline ${style.line}, Pattern: ${style.hatch}`)
  }

  console.log('\n🧪 Executing MapLibre GL JS §4.1 Automated Validation Suite...')
  const proc = spawn({
    cmd: ['bun', 'run', 'test', 'src/adapters/map/render-verification-eu-us.test.ts'],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    process.exit(exitCode)
  }

  console.log('\n======================================================================')
  console.log('🎉 FLOOD ZONE RENDERING VERIFICATION SUCCEEDED (EU & AMERICA)')
  console.log('======================================================================\n')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
