# WebMCP Test Chat Page & Disaster Safety Assistant

A local playground for exercising the [WebMCP](https://webmachinelearning.github.io/webmcp/)
browser API, now featuring an authoritative **Disaster Safety** toolset for decision support during flood and extreme weather events.

The page acts as a **tool provider** — registering WebMCP tools with the browser's model-context registry — and embeds its own **agent** backed by a local or scripted LLM, with real-time MapLibre spatial visualization.

---

## Disaster Safety Subsystem

The Disaster Safety toolset provides five core emergency capabilities across the **United States**, **Europe**, and **Japan**:

1. **Place Name Resolution (`disaster.geocode`)**: Turns a name a person would actually say — "Fukui Station", "福井駅", "Berlin Hauptbahnhof" — into coordinates for the other tools, through OpenStreetMap Nominatim. Candidates are ranked with a confidence scored against the best answer to the same query, so five equally plausible Springfields are reported as ambiguous rather than silently resolved to one. A name that matches nothing produces no coordinates at all: the one thing worse than refusing is a confident guess.
2. **Flood Inundation & Hazard Mapping (`disaster.flood_forecast`)**: Every product with something to say about the query, kept separate rather than blended. For Japan that is three at once — **気象庁 キキクル** (浸水害・洪水害 危険度分布, the only source that says what is dangerous *right now*, on a ten-minute cycle), **GSI L2** (the assumed-maximum planning envelope), and **Copernicus GloFAS** (a global 100-year model, which also covers everywhere the national sources do not). For Europe it is the **Copernicus GloFAS ensemble forecast**, retrieved from the ECMWF Data Store and scored against each grid cell's own 1991–2020 flood frequency, so a zone means "at least 30% of the ensemble puts this cell above a flood it sees once in N years" rather than an uninterpretable discharge in m³/s. A real-time risk level is never merged into a planning scenario: the union keys on zone kind and source as well as hazard class.

   The European forecast needs a free [Copernicus token](https://ewds.climate.copernicus.eu/profile) in `CEMS_API_KEY`, and the account must accept two licences once in a browser. Copernicus answers retrievals as *queued jobs*, so the first request at a new location starts the work and reports that it is under way rather than drawing an empty map. Warm a site ahead of time with `bun tools/warm-cems.ts <lat> <lon>` and leave it running: the store takes one calendar year per historical request and queues one at a time, so fitting a location's flood thresholds is 30 retrievals and a few hours — paid once per place, then read from disk forever. See [`docs/geo-sources.md`](./docs/geo-sources.md) for the store's other sharp edges, and for why EFAS — the European product proper — is not used: a non-partner token gets it on a 30-day delay against a 15-day lead time, so every forecast it can fetch has already expired.
3. **Designated Safe Shelters (`disaster.find_shelters`)**: Officially designated evacuation sites with spatial risk classification (`[CLEAR]`, `[AT RISK]`, `[UNKNOWN]`).
4. **Official Warnings & Advisories (`disaster.official_alerts`)**: Verbatim emergency warnings (JMA, NWS, MeteoAlarm) fenced with language tags to prevent prompt injection and hallucination.
5. **Evacuation Route Planning (`disaster.evacuation_routes`)**: Multi-modal routing on the OSM road network with flood exclusion zones. Several candidates per plan, ranked by how much of each runs through flood water, with only the leader highlighted. Geometry that does not follow the road network is never drawn as a route — such a destination is reported as a straight-line distance and labelled as one.
6. **Interactive Map & Accessible List Surface (`disaster.focus_map`, `disaster.clear_map`)**: Toggleable spatial layers (`user-position`, `query-radius`, `flood-zones`, `facilities`, `routes`, `search-results`) rendered with MapLibre GL JS, with automatic text-equivalent list fallback for no-WebGL environments.

Specs and design documents live in:
- [`docs/specs/disaster-safety/design.md`](docs/specs/disaster-safety/design.md) — Architectural specification and safety rules (§13).
- [`docs/specs/disaster-safety/traceability.md`](docs/specs/disaster-safety/traceability.md) — Requirement traceability matrix (R1.1–R9.5).
- [`docs/specs/disaster-safety/tech-debt.md`](docs/specs/disaster-safety/tech-debt.md) — Technical debt and future enhancement logs.
- [`docs/geo-sources.md`](docs/geo-sources.md) — Upstream endpoints, licenses, authentication, and attribution terms.
- [`docs/adding-a-region-provider.md`](docs/adding-a-region-provider.md) — Contributor guide for adding new regional data providers.

---

## Quick start

```bash
bun install
bun run dev        # SPA + API in one process, one log stream, at http://127.0.0.1:5173
```

**No LLM is required to start.** With nothing installed, the app runs the deterministic *scripted* driver and default *fixture mode*.

Try saying:
| Say | What happens |
| --- | --- |
| `disaster in tokyo` | Runs reference scenario: flood hazard zones, safe shelters, official JMA warnings, and evacuation routes |
| `add milk` | calls `todo.add`, then `todo.list`, then answers |
| `submit a contact form` | nested object, enum and array input |
| `please fail` | calls a tool that fails, then recovers and answers anyway |

## Production WebMCP

WebMCP is a progressive enhancement: the site remains usable through its in-memory adapter when a
browser does not expose the API. Chrome currently makes WebMCP available to public sites through an
Origin Trial (desktop M149–M156); local development can instead use
`chrome://flags/#enable-webmcp-testing`.

For a production origin:

1. Register the **exact HTTPS origin** at [Chrome Origin Trials](https://developer.chrome.com/origintrials/).
2. Build once with `bun run build`.
3. Run the server with deployment configuration (the token is public metadata, not a secret):

   ```bash
   HOST=0.0.0.0 \
   WEBMCP_ORIGIN_TRIAL_TOKEN='<token for https://your-origin.example>' \
   bun run start
   ```

4. Terminate TLS at the platform load balancer or reverse proxy and forward traffic to `PORT`
   (default `8787`). Do not expose a plain-HTTP public origin: WebMCP requires a secure context.
   This playground has no application-level user authentication; put access control and rate
   limiting at that edge before using a metered LLM or live data credentials on a public site.
5. Verify the deployed response and browser selection:

   ```bash
   curl -I https://your-origin.example/
   # Origin-Trial: ...
   # Permissions-Policy: tools=(self)
   ```

   In DevTools, `window.__WEBMCP_DEBUG__.getAdapter()` should report `draft-2026-04`. If the trial is
   unavailable or the token does not match the origin, the detection report explains the rejection
   and selects `in-memory` without breaking the page.

---

## Running Live Mode vs Fixture Mode

By default, the application runs in `fixture` mode using local, high-fidelity offline datasets (`fixtures/geo/*`).

**Fixtures cover recorded areas, not the whole country.** The Japanese flood fixture holds real GSI
hazard geometry for **Fukui** (the reference scenario) and a synthetic pair at **Tokyo**; ask about
anywhere else in fixture mode and the answer is an explicit "no coverage here, set
`GEO_DATA_MODE=live`" rather than an empty map. That distinction is the whole point — a flood tool
that draws nothing must never be mistaken for one that found no flood risk.

To enable live upstream network fetching through the backend proxy:

```bash
# Copy configuration
cp .env.example .env

# Set data mode in .env
GEO_DATA_MODE=live
```

The browser adopts whatever mode the backend reports from `GET /api/geo/providers` — the backend
owns the decision, because it holds the allowlist and the only network path to an upstream.

Geocoding differs from the other providers in fixture mode: it resolves a closed list of well-known
places (`fixtures/geo/global/geocode/normal.json`) and returns **nothing** for a name outside it. A
simulated shelter is still recognisably a shelter and is labelled as simulated; a simulated
*coordinate* is a specific claim about where a named place is, and every tool downstream would then
answer truthfully about the wrong place. Live mode geocodes any name, worldwide, against
OpenStreetMap Nominatim — no key required, and no key is what makes it work on a fresh clone.

Routing is where the two modes differ most visibly:

| | Fixture | Live |
| --- | --- | --- |
| Geometry | Recorded Valhalla replies, read back through the live parser — real OSM road geometry, for the origin they were captured at | Snapped to the OSM road network by Stadia Maps (Valhalla) |
| Turn-by-turn | The recorded engine manoeuvres, with street names | The engine's own manoeuvres, with street names |
| Candidates | The alternatives the engine returned at capture time | `alternates` requested per destination |
| Flood avoidance | Reported honestly, not routed around | Zones sent as `exclude_polygons` for the engine to route around |

Nothing that does not follow the road network is drawn as a route. Both providers label their
geometry `road` or `straight-line`, the live adapter re-checks the engine's geometry against
`assessRoadAdherence` before claiming `road`, and the planner draws only `road` routes. A
destination with no path to it — outside the recorded area in fixture mode, or unreachable live —
is reported as a straight-line distance and bearing, explicitly labelled as not a route.

A destination the live engine cannot serve falls back to the recorded reply rather than
disappearing, and keeps `mode: fixture` in its provenance so it is still labelled as simulated —
with the reason in the engine notes, so a missing key reads as a missing key rather than as a
routing engine with nothing to offer.

Live routing goes to **Stadia Maps**, which hosts Valhalla on OSM data; the wire format is
Valhalla's, so the same parser reads live replies and recorded fixtures. It needs a key
(`ROUTING_API_KEY`, from [Stadia Maps](https://client.stadiamaps.com/)) — the key stays on the
server, is attached by the proxy, and is redacted before anything is logged. With the key set and
the routing mode live, the server says so at startup if the key is missing rather than failing one
request at a time.

**Routing has a mode of its own** (`ROUTING_MODE`, default `auto`), separate from `GEO_DATA_MODE`.
A simulated flood zone is still shaped like a flood zone, but a simulated route is not a route:
the recorded replies cover only the origin they were captured at, so tying routing to the global
data mode left the map drawing no routes anywhere else. `auto` routes live wherever there is an
engine to route with and falls back to the recordings otherwise, so simulated hazard data with
real road routes is the default — each carrying its own provenance, and the summary saying which
half is which. Set `ROUTING_MODE=fixture` for a demo that must not touch the network at all. `ROUTING_BASE_URL`
and `ROUTING_ROUTE_PATH` point the same code at a self-hosted or EU-resident engine instead
(`/route/v1` for Stadia, `/route` for a bare Valhalla).

The backend proxy enforces:
- Strict host allowlist (`GEO_ALLOWED_HOSTS`)
- Circuit breakers per upstream host (`GEO_BREAKER_THRESHOLD`, `GEO_BREAKER_COOLDOWN_MS`)
- In-memory TTL caching with cache age inspection
- 5MB payload caps and URL API key redaction

---

## Inundation Estimation API

Besides relaying published hazard maps, the server can **estimate** inundation depth and extent
from first principles — precipitation over terrain — for anywhere on Earth, within a radius of up
to 20 km:

```bash
curl -X POST http://localhost:8787/api/geo/inundation-estimate \
  -H 'content-type: application/json' \
  -d '{"at": {"latitude": 34.6474, "longitude": 133.69}, "radiusKm": 20, "rainfallMm": 150}'
```

Omit `rainfallMm` and the next 24 h of forecast rain (Open-Meteo, sampled at five points across the
circle) is used instead; `durationHours` widens that window, and `curveNumber` (default 80) sets
the runoff character of the ground. The method is documented, citable, and volume-conserving:
SCS Curve Number runoff (USDA TR-55) over a Terrarium DEM mosaic (Mapzen/AWS Terrain Tiles, z11),
spread by Priority-Flood depression analysis with level-pool fill-and-spill routing. The DEM is
conditioned first — void pixels despiked, the sea masked as an outlet — and the answer comes back
as depth-band polygons on the GSI legend (so estimated and official zones read on one scale),
summary statistics, full provenance, and a `limitations` array that travels with every response:
this is a pluvial screening estimate, not a substitute for official hazard maps or warnings. See
[`docs/specs/inundation-estimate/`](docs/specs/inundation-estimate/requirements.md).

In fixture mode the endpoint runs the same pipeline offline on deterministic synthetic terrain.

### Coupled pluvial–fluvial model

`POST /api/geo/inundation-estimate` ponds rain where it falls. Real river flooding is driven by a
catchment far larger than any query window, so there is a second endpoint that models the river
processes too — **pluvial ponding, river routing, channel inflow from upstream, levee breaches,
dam storage, storm drainage, and building storage displacement** — in one water-balanced pass:

```bash
curl -X POST http://localhost:8787/api/geo/flood-model \
  -H 'content-type: application/json' \
  -d '{"at": {"latitude": 36.0621, "longitude": 136.2222}, "radiusKm": 5,
       "rainfallMm": 200, "leveeBreach": {"enabled": true, "widthM": 150}}'
```

It builds a drainage network (D8 flow directions and contributing area over a filled, breach-
conditioned DEM), sizes each channel by its **mean annual flood** — an annual-maximum series from 60+ years of ERA5
rainfall, Gumbel-fitted and run through the same runoff chain, so capacity comes from the
catchment's own climate rather than a relation extrapolated past its range, finds where rivers cross into the window and injects the upstream catchment's
runoff there, converts routed event volume to an SCS hydrograph peak and arrival time, and fails the
most over-capacity reaches as broad-crested weirs. Shallow-water characteristic speed contributes
the hydraulic travel time; with `backwater: true`, a standard-step energy balance also carries
downstream backwater and velocity-head effects upstream through subcritical reaches.

Rain and rivers are modelled by different mechanisms, because one method cannot do both. Rain ponds
by volume-conserving fill-and-spill in closed basins. Rivers inundate by **stage** — HAND plus a
rating curve built from the terrain around each reach — because a settled volume model can only ever
fill closed basins, and river floods happen through unsteady storage. The reported depth is the
deeper of the two per cell and its polygon is the maximum-event envelope, not a simultaneous frame.
`network.dynamics` reports arrival/peak hours and characteristic speed; with opt-in backwater it also
reports velocity, Froude number, momentum head, and backwater rise. The profile is off by default
because it reduced accuracy in the four-event hindcast. `dynamicRouting: false` reproduces the
former event-average independent-reach calculation.
Pass `upstreamRainfallMm` when the catchment's storm differs from
the town's, which for a fluvial disaster it usually does.

Mapped embankments from OpenStreetMap act as barriers: land behind an un-overtopped crest stays dry,
and a levee breach is the gap the water goes through. Coverage is uneven and every response reports
how many embankment ways it actually found, because no data must never be mistaken for no defences.

Mapped dams, storm drains/sewers/culverts, and building footprints are also applied at sub-grid
scale. A dam retains no more than its mapped upstream reservoir area times the assumed available
drawdown; a drain removes no more local runoff than its event capacity; and a building displaces
storage rather than becoming a wall across a 60–90 m cell. `infrastructure` in the response reports
the mapped coverage, retained/drained volumes, building depth multiplier, and any degraded or
truncated OSM lookup. The defaults are screening assumptions, not observed reservoir operations or
a surveyed municipal sewer model.

Validated by hindcast against four Japanese flood disasters with surveyed extents it finds about
57% of what actually flooded, while roughly four fifths of what it calls flooded did not. The
over-prediction is the honest limit of the method rather than a bug being chased: mapping extent by
height above the nearest drainage separates flooded ground from dry ground only weakly on a 60-90 m
DEM over flat alluvial plain, and the spec measures that ceiling. Treat the extent as a screening
envelope, never as a prediction.

Every response carries `timingsMs`, a per-stage cost breakdown. Terrain, climatology, embankments,
standing water, and mapped infrastructure are cached per location, so asking about the same place
under a different storm avoids re-fetching static inputs.

Quote `p99DepthMetres` rather than `maxDepthMetres`: spurious basins are carved open where a short
outlet exists, but a deep one with no way out is left filled and will own the maximum.

Every response reports a **pluvial-only baseline from the same DEM and storm**, so you can see what
the river terms added — and see when they added nothing because the terrain saturated. Tuning knobs
include `channelThresholdKm2`, `manningN`, `channelInflow`, `leveeBreach`, `useDams`,
`damAvailableStorageDepthM`, `useStormSewers`, `stormSewerCapacityMmPerHour`, `useBuildings`, and
`maximumBuildingBlockedFraction`. See
[`docs/specs/flood-model/`](docs/specs/flood-model/requirements.md) for the validation, including
the honest accuracy numbers against Japan's official L2 hazard map.


## Testing & Quality Gate

Run the complete quality gate across client and server:

```bash
bun run check     # Type checking + ESLint rules + all Vitest suites
```

Individual test suites:
- `bun run test src/domain/geo.test.ts` — Spatial geometry and coordinate precision
- `bun run test src/adapters/geo/region-geolocation.test.ts` — Region bounding boxes and geolocation adapter
- `bun run test src/lib/geometry/geometry.test.ts` — Polygon clipping, simplification budgets, raster vectorisation, and line crossings
- `bun run test server/geo-proxy.test.ts` — Backend proxy allowlist, caching, circuit breakers, and `/api/geo/*` routes
- `bun run test src/adapters/geo/conformance.test.ts` — Conformance suite across all regional and fixture providers
- `bun run test src/app/hazard/routing-service.test.ts` — Destination ranking, exclusion routing, and fallbacks
- `bun run test src/app/hazard/summarise.test.ts` — Safety mechanics (§13): banners, verbatim fencing, scenario wording, 4KB budget
- `bun run test src/lib/hydrology` — Flood physics: SCS-CN runoff, DEM conditioning, drainage networks, channel hydraulics, breach outflow, catchment response, and volume-conserving spreading
- `bun run test server/routes/inundation.test.ts` — Pluvial inundation route: validation, fixture/live pipelines, and caching
- `bun run test server/routes/flood-model.test.ts` — Coupled flood route: network extraction, channel inflow, levee breaching, dams, storm drainage, buildings, and caching
- `bun run test src/toolsets/disaster.test.ts` — Disaster safety WebMCP tool definitions and execution
- `bun run test src/ui/map/MapPane.test.tsx` — MapPane layer toggles, legend, attribution, and text view
- `bun run test src/app/reference-scenario.test.ts` — End-to-end reference scenario integration test
