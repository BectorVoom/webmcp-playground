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
| **R2.4** Raster depth legend, pinned to real GSI tiles | `src/lib/geometry/raster.ts` | `src/lib/geometry/raster.test.ts` |
| **R2.4** Raster vectorisation (runs → rectangles → one dissolve) | `src/lib/geometry/contour.ts` | `src/lib/geometry/contour.test.ts`, `src/adapters/geo/jp/flood.test.ts` |
| **R8.3** Colour outside the legend is unreadable, never guessed | `src/lib/geometry/raster.ts`, `src/adapters/geo/jp/flood.ts` (`describeCoverage`) | `src/lib/geometry/raster.test.ts`, `src/adapters/geo/jp/flood.test.ts` |
| **N3/N5** Vectorising a real tile stays inside the time and vertex budgets | `src/lib/geometry/contour.ts` (`DEFAULT_CELL_METRES`), `src/lib/geometry/simplify.ts` | `src/lib/geometry/contour.test.ts` |
| **R2.5** Tile cap covers the whole query circle (512 default, 441 needed at 20 km) | `src/adapters/geo/jp/flood.ts` (`DEFAULT_TILE_CAP`), `server/config.ts` | `src/adapters/geo/jp/flood.test.ts`, `server/config.test.ts` |
| **R2.5** `GEO_TILE_CAP` reaches the client that fetches the tiles | `server/routes/geo.ts` (`/providers`), `src/toolsets/disaster.ts`, `src/adapters/geo/jp/flood.ts` (`setGsiTileCap`) | `src/adapters/geo/jp/flood.test.ts`, `server/routes/geocode.test.ts` |
| **N2/N5** Working cell scales with radius so full coverage stays in budget | `src/adapters/geo/jp/flood.ts` (`cellMetresForRadius`) | `src/adapters/geo/jp/flood.test.ts` |
| **R2.8/R8.5** An empty flood map says why, in the provider's own words | `src/app/hazard/snapshot.ts`, `src/app/hazard/summarise.ts` (`summariseFlood`) | `src/app/hazard/summarise.test.ts` |
| **R6.4** Fixture mode covers the reference scenario at Fukui, and names its limits elsewhere | `src/adapters/geo/fixture/fixture-flood.ts`, `fixtures/geo/jp/flood/normal.json` | `src/adapters/geo/fixture/fixture-flood.test.ts` |
| **R2.1/R2.2** Real-time flood risk (気象庁 キキクル 浸水害・洪水害) | `src/adapters/geo/jp/kikikuru.ts` | `src/adapters/geo/jp/kikikuru.test.ts`, `src/adapters/geo/conformance.test.ts` |
| **R2.1/R6.3** Global flood hazard (Copernicus GloFAS `FloodHazard100y`) | `src/adapters/geo/glofas-flood.ts` | `src/adapters/geo/glofas-flood.test.ts`, `src/adapters/geo/conformance.test.ts` |
| **R2.1/R2.2** European flood forecast (Copernicus GloFAS ensemble, scored against 1991–2020 return levels) | `src/adapters/geo/eu/flood.ts`, `server/routes/cems-forecast.ts`, `server/cems/glofas-service.ts` | `src/adapters/geo/eu/flood.test.ts`, `server/routes/cems-forecast.test.ts`, `server/cems/glofas-service.test.ts`, `src/adapters/geo/conformance.test.ts` |
| **R2.1** Copernicus retrievals are queued jobs, so the route is cache-first and answers `pending` | `server/cems/glofas-service.ts` (`advance`), `server/cems/store-client.ts` | `server/cems/glofas-service.test.ts`, `server/routes/cems-forecast.test.ts` |
| **R2.8/R8.5** "Not retrieved yet" is a coverage statement, never an empty flood map | `src/adapters/geo/eu/flood.ts` (`notReady`) | `src/adapters/geo/eu/flood.test.ts` |
| **R7.4** Copernicus token is read server-side only, from env or a `.cdsapirc` block, and never reaches the bundle | `server/cems/credentials.ts`, `server/routes/cems-forecast.ts` | `server/cems/credentials.test.ts` |
| **R6.3** GRIB2 retrievals are decoded without a dependency; an undecodable format or an unknown product template is named, not misparsed | `server/cems/grib2.ts` (`sniffFormat`, `PRODUCT_LAYOUTS`) | `server/cems/grib2.test.ts`, incl. a recorded live retrieval at `fixtures/geo/eu/flood/upstream/glofas-forecast-cologne.grib.json` |
| **R2.2/ADR-2** A forecast is never merged into a scenario, nor one source into another | `src/lib/geometry/clip.ts` (`mergeKey`) | `src/lib/geometry/clip.test.ts` |
| **R7.1/R7.8** Binary raster proxy for client-built URLs, still allowlisted | `server/routes/geo.ts` (`POST /api/geo/raster`) | `server/routes/geocode.test.ts` |
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
| **R3.3** Pedestrian, bicycle, and auto costing options, routed by Stadia Maps | `src/domain/routing.ts`, `src/ports/Routing.ts`, `src/adapters/geo/routing/stadia.ts`, `server/routes/geo.ts` | `src/adapters/geo/conformance.test.ts`, `src/adapters/geo/routing/stadia.test.ts`, `server/routes/stadia-routing.test.ts` |
| **R3.4** Polygon exclusion areas for flood avoidance | `src/app/hazard/routing-service.ts`, `src/adapters/geo/routing/stadia.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.5** Fallback retry marked as `unavoided` with warning | `src/app/hazard/routing-service.ts`, `src/app/hazard/summarise.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.6** Flood crossing detection on route line geometries | `src/lib/geometry/crossings.ts` (`assessRouteCrossings`) | `src/lib/geometry/geometry.test.ts` |
| **R3.7** Result destination caps (default 3) | `src/app/hazard/routing-service.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.8** Engine-absent straight-line fallback with explicit disclaimer | `src/app/hazard/routing-service.ts` | `src/app/hazard/routing-service.test.ts` |
| **R3.9** Engine routing assumptions noted in output | `src/app/hazard/summarise.ts` (`summariseRoutes`) | `src/app/hazard/summarise.test.ts` |
| **R3.10** Empty facility radius handling | `src/app/hazard/routing-service.ts`, `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R3.11** Only road-network geometry is drawn as a route | `src/lib/geometry/road-network.ts` (`assessRoadAdherence`), `src/adapters/geo/routing/stadia.ts`, `src/adapters/geo/fixture/fixture-routing.ts`, `src/app/hazard/routing-service.ts` | `src/lib/geometry/road-network.test.ts`, `src/adapters/geo/fixture/fixture-routing.test.ts`, `src/adapters/geo/routing/stadia.test.ts`, `src/app/hazard/routing-service.test.ts` |
| **R3.12** Ranked candidates, one highlighted at a time | `src/app/hazard/routing-service.ts` (`compareRouteSafety`, `selectRouteCandidates`), `src/adapters/map/maplibre.ts` (`highlightRoute`), `src/ui/map/RouteDirections.tsx` | `src/app/hazard/routing-service.test.ts`, `src/adapters/map/maplibre.test.tsx`, `src/ui/map/RouteDirections.test.tsx`, `src/ui/map/MapPane.test.tsx` |

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
| **R5.7** Legend and map read one colour table, so the legend describes what is drawn | `src/lib/hazard-palette.ts`, `src/ui/map/Legend.tsx`, `src/adapters/map/maplibre.ts` | `src/lib/hazard-palette.test.ts`, `src/ui/map/Legend.test.tsx`, `src/adapters/map/maplibre.test.tsx` |
| **R5.7** Non-colour encoding of hazard class | *not implemented* — `tech-debt.md` §1c | — |
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

---

## 8. Place Name Resolution (R11)

| Requirement | Implementation Module | Verification Test |
| :--- | :--- | :--- |
| **R11.1** Name to WGS84 coordinates | `src/toolsets/disaster.ts` (`disaster.geocode`), `src/adapters/geo/nominatim-geocoding.ts`, `src/adapters/geo/fixture/fixture-geocoding.ts` | `src/toolsets/disaster.test.ts`, `src/adapters/geo/nominatim-geocoding.test.ts` |
| **R11.2** Ranked candidates with name, context, kind, provenance | `src/domain/geocoding.ts`, `src/adapters/geo/nominatim-geocoding.ts` (`relativeConfidence`) | `src/adapters/geo/nominatim-geocoding.test.ts`, `src/domain/geocoding.test.ts` |
| **R11.3** No match yields no coordinates, and says so | `src/app/hazard/summarise.ts` (`summariseGeocode`) | `src/app/hazard/summarise.test.ts`, `src/toolsets/disaster.test.ts` |
| **R11.4** Ambiguity marked, and no candidate nominated | `src/domain/geocoding.ts` (`isAmbiguous`), `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts`, `src/adapters/geo/nominatim-geocoding.test.ts` |
| **R11.5** Area match declared a label point, not an address | `src/adapters/geo/nominatim-geocoding.ts` (`classifyPlace`), `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R11.6** Region and authority stated per match | `src/adapters/geo/region.ts` (`findRegion`), `src/app/hazard/summarise.ts` | `src/app/hazard/summarise.test.ts` |
| **R11.7** Empty or coordinate-pair query fails, tagged | `src/domain/geo-errors.ts` (`GeocodeQueryInvalid`), `src/adapters/geo/nominatim-geocoding.ts` | `src/adapters/geo/nominatim-geocoding.test.ts`, `src/toolsets/disaster.test.ts` |
| **R11.8** Fixture geocoder invents nothing (ADR-11) | `src/adapters/geo/fixture/fixture-geocoding.ts` | `src/adapters/geo/fixture/fixture-geocoding.test.ts` |
| **R7.2** Geocode route boundary validation | `server/routes/geo.ts` (`POST /api/geo/geocode`) | `server/routes/geocode.test.ts` |
| **R7.3** Geocode cache TTL keyed on the query | `server/routes/geo.ts`, `server/config.ts` (`GEO_CACHE_TTL_GEOCODE_MS`) | `server/routes/geocode.test.ts`, `server/config.test.ts` |
| **R5.2** `search-results` layer, toggleable and framed | `src/ports/Map.ts`, `src/adapters/map/maplibre.ts`, `src/ui/map/LayerList.tsx` | `src/adapters/map/maplibre.test.tsx` |

