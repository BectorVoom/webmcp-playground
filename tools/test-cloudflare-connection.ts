import { Effect } from 'effect'
import { loadConfig } from '../server/config'
import { createApp } from '../server/index'

const CLOUDFLARE_URL = 'https://disaster-safety-backend-api.appservice27.workers.dev'

async function runTests() {
  console.log(`\n======================================================`)
  console.log(`🌐 Testing WebMCP Connection to Cloudflare Backend API`)
  console.log(`Endpoint: ${CLOUDFLARE_URL}`)
  console.log(`======================================================\n`)

  let passed = 0
  let failed = 0

  // 1. Direct Cloudflare Health Check
  try {
    const res = await fetch(`${CLOUDFLARE_URL}/api/health`)
    const data = await res.json()
    if (res.status === 200 && data.ok) {
      console.log(`✅ [1/5] Direct Cloudflare Health: OK (Status ${res.status}, Mode: ${data.geo?.dataMode})`)
      passed++
    } else {
      console.error(`❌ [1/5] Direct Cloudflare Health Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [1/5] Direct Cloudflare Health Error:`, err)
    failed++
  }

  // 2. Direct Cloudflare Providers Capabilities
  try {
    const res = await fetch(`${CLOUDFLARE_URL}/api/geo/providers`)
    const data = await res.json()
    if (res.status === 200 && data.routingConfigured) {
      console.log(`✅ [2/5] Cloudflare Providers Handshake: OK (routingMode: ${data.routingMode}, routingConfigured: ${data.routingConfigured})`)
      passed++
    } else {
      console.error(`❌ [2/5] Cloudflare Providers Handshake Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [2/5] Cloudflare Providers Handshake Error:`, err)
    failed++
  }

  // 3. WebMCP Server -> Cloudflare Reverse Proxy Handshake
  try {
    const config = Effect.runSync(loadConfig({
      BACKEND_API_URL: CLOUDFLARE_URL
    }))
    const app = createApp(config)
    const res = await app.request('/api/geo/providers')
    const data = await res.json()
    if (res.status === 200 && data.ok && data.routingConfigured) {
      console.log(`✅ [3/5] WebMCP Server -> Cloudflare Proxy: OK (Successfully forwarded and returned live providers)`)
      passed++
    } else {
      console.error(`❌ [3/5] WebMCP Server -> Cloudflare Proxy Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [3/5] WebMCP Server -> Cloudflare Proxy Error:`, err)
    failed++
  }

  // 4. WebMCP Server -> Cloudflare -> Stadia Valhalla Live Route
  try {
    const config = Effect.runSync(loadConfig({
      BACKEND_API_URL: CLOUDFLARE_URL
    }))
    const app = createApp(config)
    const res = await app.request('/api/geo/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [
          { lat: 35.6812, lon: 139.7671 }, // Tokyo Station
          { lat: 35.6895, lon: 139.6917 }  // Shinjuku Station
        ],
        costing: 'auto'
      })
    })
    const data = await res.json()
    if (res.status === 200 && data.trip?.summary) {
      const summary = data.trip.summary
      console.log(`✅ [4/5] WebMCP -> Cloudflare -> Live Valhalla Route: OK (${summary.length} km, estimated ${Math.round(summary.time / 60)} mins)`)
      passed++
    } else {
      console.error(`❌ [4/5] Live Route Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [4/5] Live Route Error:`, err)
    failed++
  }

  // 5. WebMCP Server -> Cloudflare -> Live Reverse Geocode / Place lookup
  try {
    const config = Effect.runSync(loadConfig({
      BACKEND_API_URL: CLOUDFLARE_URL
    }))
    const app = createApp(config)
    const res = await app.request('/api/geo/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Tokyo Station' })
    })
    const data = await res.json()
    if (res.status === 200 && data.ok) {
      console.log(`✅ [5/5] WebMCP -> Cloudflare -> Geocode Service: OK (Status ${res.status})`)
      passed++
    } else {
      console.error(`❌ [5/5] Geocode Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [5/5] Geocode Error:`, err)
    failed++
  }

  console.log(`\n======================================================`)
  console.log(`📊 Test Summary: ${passed} passed, ${failed} failed`)
  console.log(`======================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
