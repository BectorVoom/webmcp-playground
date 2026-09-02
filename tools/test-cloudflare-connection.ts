import { Effect } from 'effect'
import { loadConfig } from '../server/config'
import { createApp } from '../server/index'

const CLOUDFLARE_URL = 'https://disaster-safety-backend-api.appservice27.workers.dev'
const WEBMCP_SECRET = 'wmcp_sec_1e9b7b142bfa42eeb6edbfadbde6f0c08c30ef166db547a8aa954105ce79c4f2'

async function runTests() {
  console.log(`\n======================================================================`)
  console.log(`🔒 Testing WebMCP & Cloudflare Exclusive Traffic Security Enforcement`)
  console.log(`Endpoint: ${CLOUDFLARE_URL}`)
  console.log(`======================================================================\n`)

  let passed = 0
  let failed = 0

  // 1. Security Check: Unauthenticated incoming traffic MUST be blocked (401 Unauthorized)
  try {
    const res = await fetch(`${CLOUDFLARE_URL}/api/health`)
    const data = await res.json()
    if (res.status === 401 && data.error === 'Unauthorized') {
      console.log(`✅ [1/5] Non-WebMCP Traffic Blocked: OK (HTTP 401 Unauthorized, message: "${data.message}")`)
      passed++
    } else {
      console.error(`❌ [1/5] Non-WebMCP Traffic Was NOT Blocked! Status: ${res.status}`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [1/5] Security Check Error:`, err)
    failed++
  }

  // 2. Direct Authorized WebMCP Request: Must be permitted (200 OK)
  try {
    const res = await fetch(`${CLOUDFLARE_URL}/api/health`, {
      headers: { 'x-webmcp-secret': WEBMCP_SECRET }
    })
    const data = await res.json()
    if (res.status === 200 && data.ok) {
      console.log(`✅ [2/5] Authorized WebMCP Direct Request: OK (HTTP 200, Mode: ${data.geo?.dataMode})`)
      passed++
    } else {
      console.error(`❌ [2/5] Authorized WebMCP Direct Request Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [2/5] Authorized WebMCP Direct Request Error:`, err)
    failed++
  }

  // 3. WebMCP Server Proxy with Shared Secret -> Cloudflare Handshake
  try {
    const config = Effect.runSync(loadConfig({
      BACKEND_API_URL: CLOUDFLARE_URL,
      WEBMCP_SHARED_SECRET: WEBMCP_SECRET,
    }))
    const app = createApp(config)
    const res = await app.request('/api/geo/providers')
    const data = await res.json()
    if (res.status === 200 && data.ok && data.routingConfigured) {
      console.log(`✅ [3/5] WebMCP Reverse Proxy with Secret: OK (routingMode: ${data.routingMode}, routingConfigured: ${data.routingConfigured})`)
      passed++
    } else {
      console.error(`❌ [3/5] WebMCP Reverse Proxy Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [3/5] WebMCP Reverse Proxy Error:`, err)
    failed++
  }

  // 4. WebMCP Server -> Cloudflare -> Live Valhalla Routing with Secret
  try {
    const config = Effect.runSync(loadConfig({
      BACKEND_API_URL: CLOUDFLARE_URL,
      WEBMCP_SHARED_SECRET: WEBMCP_SECRET,
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
      console.log(`✅ [4/5] WebMCP -> Cloudflare -> Live Route: OK (${summary.length} km, estimated ${Math.round(summary.time / 60)} mins)`)
      passed++
    } else {
      console.error(`❌ [4/5] Live Route Failed:`, data)
      failed++
    }
  } catch (err) {
    console.error(`❌ [4/5] Live Route Error:`, err)
    failed++
  }

  // 5. WebMCP Server -> Cloudflare -> Geocode with Secret
  try {
    const config = Effect.runSync(loadConfig({
      BACKEND_API_URL: CLOUDFLARE_URL,
      WEBMCP_SHARED_SECRET: WEBMCP_SECRET,
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

  console.log(`\n======================================================================`)
  console.log(`📊 Security Test Summary: ${passed} passed, ${failed} failed`)
  console.log(`======================================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
