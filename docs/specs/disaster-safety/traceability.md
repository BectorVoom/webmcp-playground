# Requirement Traceability Matrix: Disaster Safety

This document maps every requirement defined in `docs/specs/disaster-safety/design.md` to its implementation files and test suites.

---

## 1. Geolocation & Spatial Boundaries

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R1.1** WGS84 Standard (`LonLat`) | `src/domain/geo.ts` | `src/domain/geo.test.ts` |
| **R1.2** Outbound / Trace coordinate rounding | `src/domain/geo.ts` (`roundCoordsForOutbound`, `roundCoordsForTrace`) | `src/domain/geo.test.ts` |
| **R1.3** Explicit coordinates precedence over geolocation | `src/toolsets/disaster.ts` (`resolveOrUseLocation`) | `src/toolsets/disaster.test.ts` |
| **R1.4** TTL-based geolocation caching (60s default) | `src/adapters/geo/browser-geolocation.ts` | `src/adapters/geo/region-geolocation.test.ts` |
| **R1.5** Insecure origin / geolocation failure handling | `src/adapters/geo/browser-geolocation.ts`, `src/domain/geo-errors.ts` | `src/adapters/geo/region-geolocation.test.ts` |
| **R1.6** Bounding box region resolution (JP, US, EU) | `src/adapters/geo/region.ts` (`resolveRegion`) | `src/adapters/geo/region-geolocation.test.ts` |
| **R1.7** Position source declared in result text | `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R1.8** Pinned position override for testing | `src/adapters/geo/browser-geolocation.ts` (`setPinnedPosition`) | `src/toolsets/disaster.test.ts` |
| **R1.9** Radius clamping (1–20 km) with notice | `src/domain/geo.ts` (`clampRadius`), `src/toolsets/disaster.ts` | `src/domain/geo.test.ts`, `src/toolsets/disaster.test.ts` |

---

## 2. Hazard Map & Flood Forecasts

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R2.1** Distinct `forecast` vs `scenario` in domain | `src/domain/hazard.ts` (`ZoneKind`) | `src/domain/geo.test.ts` |
| **R2.2** Scenario wording disallows the word "forecast" | `src/app/hazard/summarise.ts` (`summariseFlood`) | `src/app/hazard/summarise.test.ts` |
| **R2.3** Depth band classification (`extreme`, `high`, `moderate`, `low`) | `src/domain/hazard.ts`, `src/lib/geometry/raster.ts` | `src/lib/geometry/geometry.test.ts` |
| **R2.4** Clipping & union within query circle | `src/lib/geometry/clip.ts` | `src/lib/geometry/geometry.test.ts` |
| **R2.5** Simplification under vertex budget | `src/lib/geometry/simplify.ts` (`simplifyZonesToBudget`) | `src/lib/geometry/geometry.test.ts` |
| **R2.6** User point-in-polygon containment detection | `src/lib/geometry/measure.ts` (`findContainingZone`) | `src/lib/geometry/geometry.test.ts` |
| **R2.7** Nearest hazard edge distance and compass direction | `src/lib/geometry/measure.ts` (`findNearestZoneEdge`) | `src/lib/geometry/geometry.test.ts` |
| **R2.8** `NONE` coverage disclaimer before content | `src/app/hazard/summarise.ts` (`summariseFlood`) | `src/app/hazard/summarise.test.ts` |

---

## 3. Shelters & Evacuation Routes

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R3.1** Facility risk assessment (`clear`, `at_risk`, `unknown`) | `src/lib/geometry/measure.ts` (`assessFacilityRisk`) | `src/lib/geometry/geometry.test.ts` |
| **R3.2** Destination ranking: clear -> at_risk -> unknown | `src/app/hazard/routing-service.ts` (`rankFacilities`) | `src/app/hazard/routing-service.test.ts` |
| **R3.3** Pedestrian, bicycle, and auto costing options | `src/domain/routing.ts`, `src/ports/Routing.ts` | `src/adapters/geo/conformance.test.ts` |
| **R3.4** Polygon exclusion areas for flood avoidance | `src/app/hazard/routing-service.ts`, `src/adapters/geo/routing/valhalla.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.5** Fallback retry marked as `unavoided` with warning | `src/app/hazard/routing-service.ts`, `src/app/hazard/summarise.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.6** Flood crossing detection on route line geometries | `src/lib/geometry/crossings.ts` (`assessRouteCrossings`) | `src/lib/geometry/geometry.test.ts` |
| **R3.7** Result destination caps (default 3) | `src/app/hazard/routing-service.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.8** Engine-absent straight-line fallback with explicit disclaimer | `src/app/hazard/routing-service.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.9** Engine routing assumptions noted in output | `src/app/hazard/summarise.ts` (`summariseRoutes`) | `src/app/hazard/summarise.test.ts` |
| **R3.10** Empty facility radius handling | `src/app/hazard/routing-service.ts`, `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |

---

## 4. Official Alerts & Prompts

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R4.1** Common Alerting Protocol (CAP) model | `src/domain/alerts.ts` (`OfficialAlert`) | `src/domain/geo.test.ts` |
| **R4.2** Active / expired alert filtering | `src/adapters/geo/fixture/fixture-alerts.ts` | `src/adapters/geo/conformance.test.ts` |
| **R4.3** Severity, urgency, and certainty preservation | `src/domain/alerts.ts`, `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R4.4** Alert list truncation with explicit notice | `src/app/hazard/summarise.ts` (`enforce4KbBudget`) | `src/app/hazard/summarise.test.ts` |
| **R4.6** Verbatim upstream text fenced with language tag | `src/app/hazard/summarise.ts` (`summariseAlerts`) | `src/app/hazard/summarise.test.ts` |
| **R4.7** Official translation presented alongside original | `src/domain/alerts.ts`, `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R4.8** Untrusted content isolation (prompt injection test) | `src/domain/tool.ts`, `fixtures/geo/jp/alerts/normal.json` | `src/app/hazard/summarise.test.ts` |

---

## 5. Map Surface & Rendering

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R5.1** `MapPort` seam isolating MapLibre GL JS | `src/ports/Map.ts`, `src/adapters/map/maplibre.ts` | `eslint.config.js`, `tools/lint-rules.test.ts` |
| **R5.2** Five individually toggleable layers | `src/ui/map/LayerList.tsx`, `src/ui/map/MapPane.tsx` | `src/ui/map/MapPane.test.tsx` |
| **R5.3** Focus and clear programmatic camera controls | `src/ports/Map.ts`, `src/toolsets/disaster.ts` | `src/ui/map/MapPane.test.tsx` |
| **R5.4** Attribution bar for active data layers | `src/ui/map/AttributionBar.tsx` | `src/ui/map/MapPane.test.tsx` |
| **R5.6** No-basemap fallback mode | `src/adapters/map/maplibre.ts`, `src/ui/map/MapPane.tsx` | `src/ui/map/MapPane.test.tsx` |
| **R5.7** Visual legend encoding patterns + colours | `src/ui/map/Legend.tsx` | `src/ui/map/MapPane.test.tsx` |
| **R5.8** Text-equivalent list representation (N7) | `src/ui/map/TextEquivalentListView.tsx` | `src/ui/map/MapPane.test.tsx` |
| **R5.9** No-WebGL automatic graceful fallback | `src/ui/map/MapPane.tsx` | `src/ui/map/MapPane.test.tsx` |

---

## 6. Backend Proxy & Resilience

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R7.1** Backend proxy routes `/api/geo/*` | `server/routes/geo.ts` | `server/geo-proxy.test.ts` |
| **R7.2** Boundary schema validation with Effect Schema | `server/routes/geo.ts` | `server/geo-proxy.test.ts` |
| **R7.3** In-memory TTL caching with cache age header | `server/geo-proxy.ts` | `server/geo-proxy.test.ts` |
| **R7.5** Retries with exponential backoff on 5xx | `server/geo-proxy.ts` | `server/geo-proxy.test.ts` |
| **R7.6** Circuit breaker per upstream host | `server/geo-proxy.ts` | `server/geo-proxy.test.ts` |
| **R7.8** Strict outbound allowlist enforcement | `server/config.ts`, `server/geo-proxy.ts` | `server/geo-proxy.test.ts` |
| **R7.10** Stream response byte capping (5MB) | `server/geo-proxy.ts` | `server/geo-proxy.test.ts` |
| **R7.11** Diagnostic provider status on `/api/health` | `server/routes/health.ts`, `src/domain/wire.ts` | `server/geo-proxy.test.ts` |

---

## 7. Safety, Disclaimers, and Non-Goals (§13)

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R8.1** Line 1 advisory banner | `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R8.2** Line 1 names local issuing authority | `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R8.4** Line 2 fixture mode marker | `src/app/hazard/summarise.ts`, `src/ui/map/DataModeBanner.tsx` | `src/app/hazard/summarise.test.ts`, `src/ui/map/MapPane.test.tsx` |
| **R8.5** Visible staleness / coverage warning in result | `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R8.6** Verbatim fence prevents prompt injection escape | `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R8.8** 4 KB local context budget | `src/app/hazard/summarise.ts` (`enforce4KbBudget`) | `src/app/hazard/summarise.test.ts` |
| **R8.10** Attribution on every response | `src/domain/provenance.ts`, `src/app/hazard/summarise.ts` | `src/adapters/geo/conformance.test.ts` |
