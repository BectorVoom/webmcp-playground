# Tasks — Disaster Safety Tool Set

- **Status:** Complete (All phases 0–11 implemented and verified)
- **Last updated:** 2026-08-29
- **Inputs:** [`requirements.md`](./requirements.md) · [`design.md`](./design.md)

## How to read this

Tasks are dependency-ordered; anything in the same phase with no listed dependency can run in
parallel. Every task names the requirements it satisfies — a task that cannot be traced to a
requirement is out of scope and should be challenged rather than done.

`Deps` are task ids. `Size` is S (< 1 h), M (1–3 h), L (half a day), XL (a day or more).
Each phase ends with a **checkpoint**: a verifiable state, not a feeling of progress.

Baseline: the existing playground with its ports, trace store, Effect runtime, error taxonomy, and
Hono backend. This feature **extends** those; nothing here re-implements them.

Two rules apply throughout, and they are the ones to hold under time pressure:

- **Fixtures before live providers.** Every port gets its fixture provider and its conformance suite
  before any network code exists. A live provider is then proven equivalent, not merely written.
- **Nothing ships without provenance.** A datum that cannot say where it came from does not enter the
  domain, in any phase.

---

## Phase 0 — Foundation and source survey

The survey is the only task here that is not mechanical, and it gates the three regional phases.
Doing it late means discovering a licence problem after writing the provider.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 0.1 | **Source survey.** For each region and each of flood / facilities / alerts: confirm the endpoint, auth, payload shape, refresh interval, whether it is forecast or scenario data, rate limits, required headers, and **licence and attribution terms**. Record one row per source in `docs/geo-sources.md`, with a link to the terms. Drop any source whose terms this project cannot satisfy, and say so in the row. | — | **XL** | **R6.7**, R8.10, R10.3, design §4.2 |
| 0.2 | Add dependencies: `maplibre-gl`, `@turf/*` (only the modules used), `@mapbox/tile-cover`-equivalent or a local slippy-tile helper. Justify each against the "only necessary dependencies" rule in a one-line comment in `package.json`'s PR description. | — | S | C |
| 0.3 | ESLint rules: `maplibre-gl` importable only under `src/adapters/map/**`, `@turf/*` only under `src/lib/geometry/**`, upstream host literals only under `src/adapters/geo/**`; extend `tools/lint-rules.test.ts` so each rule is tested, not merely configured. | 0.2 | M | **R6.1**, design §14.3 |
| 0.4 | Create the `src/{domain,ports,adapters/geo,adapters/map,lib/geometry,app/hazard}` skeleton and `fixtures/geo/`. | — | S | design §2.2 |
| 0.5 | Extend `.env.example` and the startup config with every variable in design §10.1, failing fast with the variable named; assert the app starts with **no** keys set and reports `GEO_DATA_MODE=fixture`. | 0.4 | M | **R7.7** |
| 0.6 | Add `GEO_ALLOWED_HOSTS` parsing and a unit test proving an unlisted host is refused before any request is made. | 0.5 | M | **R7.8** |

**Checkpoint 0:** `bun run check` green; `docs/geo-sources.md` lists every candidate source with its
licence verdict; the three seam rules fail the build when violated.

---

## Phase 1 — Domain and provenance

Pure, dependency-free, and the vocabulary every later phase speaks. `Provenance` and `ZoneKind` are
the two types the safety requirements ride on.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 1.1 | `domain/geo.ts`: `LonLat`, `BBox`, `Bearing`, radius clamping (1–20 km) with a "was clamped" result, GeoJSON type aliases. | 0.4 | M | **R1.9** |
| 1.2 | `domain/provenance.ts`: `Provenance`, `DataMode`, `Coverage`, `Staleness`, and the staleness calculation against `expectedRefreshMs`. | 1.1 | M | **R2.3**, **R2.9**, R7.3, R8.1 |
| 1.3 | `domain/hazard.ts`: `ZoneKind` union, `HazardClass`, `DepthBand`, `FloodZone`, `HazardSnapshot`. | 1.2 | M | **R2.2**, R2.3 |
| 1.4 | `domain/places.ts` and `domain/routing.ts`: `SafeFacility`, `RiskState` (three states — `unknown` is not `clear`), `EvacuationRoute`, `CrossingReport`, `exclusions` discriminator. | 1.3 | M | **R3.2**, R3.5, R3.6 |
| 1.5 | `domain/alerts.ts`: CAP-aligned `OfficialAlert` with verbatim text fields, a `language` tag, and **no** summary or translation field. | 1.2 | M | **R4.2**, **R4.6**, ADR-5 |
| 1.6 | `domain/geo-errors.ts`: every tagged error in design §11 with its remedy hint; `NoDataCoverage` deliberately modelled as a value, not an error. | 1.2 | M | **R8.9**, ADR-3 |
| 1.7 | Coordinate rounding helpers (4 dp outbound, 3 dp for traces and area queries) with tests at the boundary values. | 1.1 | S | **R1.6**, **R8.7** |

**Checkpoint 1:** domain compiles with no imports beyond `effect`; a test proves a scenario zone
cannot be constructed with a valid-time and a forecast zone cannot be constructed without one.

---

## Phase 2 — Ports, region resolution, registry

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 2.1 | `ports/FloodData.ts`, `Places.ts`, `Alerts.ts` — query in, `{results, coverage, staleness}` out, in app vocabulary only. | 1.3–1.5 | M | **R6.1** |
| 2.2 | `ports/Routing.ts` — origin, destinations, costing, optional exclusions; per-destination route or tagged reason. | 1.4 | M | R3.3, R3.5 |
| 2.3 | `ports/Geolocation.ts` — `ResolvedLocation` with `source`, accuracy, and TTL reuse semantics. | 1.1 | M | R1.3, R1.5, R1.7 |
| 2.4 | `ports/Map.ts` — command port (`setLayer`, `focus`, `clear`, `readLayer`), so no tool imports MapLibre and the debug handle reads through the same seam. | 1.1 | M | **R5.5** |
| 2.5 | `adapters/geo/region.ts` — region rules as data with a source note per boundary, matched-rule recorded, `RegionUnsupported` with no nearest-region fallback. | 1.6 | M | **R6.2**, **R6.3** |
| 2.6 | `adapters/geo/registry.ts` — region bundles, flood slot as a list; `ProviderMeta` required per provider. | 2.1, 2.5 | M | **R6.8**, R6.7 |
| 2.7 | `adapters/geo/http.ts` — backend-proxied fetch with boundary `Schema` decode, `UpstreamPayloadInvalid` naming the failing path, raw-body capture for the trace (truncated, truncation marked). | 2.1 | L | **R6.6**, **R9.2** |
| 2.8 | `adapters/geo/browser-geolocation.ts` — three distinct failure tags, insecure-context detection, TTL cache, pinned override from URL config and the debug handle. | 2.3 | L | **R1.1–R1.5**, **R1.8** |

**Checkpoint 2:** region resolution and geolocation are unit-tested end to end; a point in Seoul
produces `RegionUnsupported` naming the supported regions, and no provider is consulted.

---

## Phase 3 — Geometry library

Pure, synchronous, browser-free. The one place `@turf/*` is imported.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 3.1 | `circle.ts` — query circle and bbox from centre + radius. | 1.1 | S | R1.9, R2.1 |
| 3.2 | `clip.ts` — clip to circle, union per hazard class, with tests for zones straddling the boundary and for overlapping duplicates from two sources. | 3.1 | M | **R2.6** |
| 3.3 | `simplify.ts` — vertex-budget search (double the tolerance until the budget fits), returning vertices in and out; separate budgets for map and routing. | 3.2 | M | **R2.6**, N5 |
| 3.4 | `measure.ts` — point-in-polygon, nearest edge with distance and compass bearing, along-route distance. | 3.1 | M | **R2.7**, R2.10, R3.2 |
| 3.5 | `crossings.ts` — route × zones intersection count and first-crossing distance; `assessed: false` when there was no coverage to assess against. | 3.4 | M | **R3.6** |
| 3.6 | `tiles.ts` — slippy-tile range covering a circle at a given zoom, with the cap applied and the covered fraction computed when it binds. | 3.1 | M | **R2.5** |
| 3.7 | `raster.ts` — tile → pixels via `OffscreenCanvas`; legend lookup with a colour tolerance, `unclassified` for anything outside it, never a guess. | 3.6 | L | **R2.4**, R8.3 |
| 3.8 | `contour.ts` — marching squares per depth class, pixel → WGS84, seam rejoin across tiles. | 3.7 | **XL** | **R2.4** |
| 3.9 | Chunking: no geometry span blocks the main thread for more than 50 ms; assert with a synthetic 5 000-feature input under 250 ms. | 3.2–3.8 | M | **N3** |

**Checkpoint 3:** a recorded tile set vectorises to an expected polygon count and total area within
tolerance, and the whole geometry suite runs in jsdom with no network.

---

## Phase 4 — Backend proxy

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 4.1 | `server/routes/geo.ts` skeleton: the six routes of design §10, bodies validated at the boundary, `400` with structured field errors. | 0.5 | L | R7.1, **R7.2** |
| 4.2 | Outbound allowlist enforcement on every proxied request, refusal logged and surfaced as `HostNotAllowed`. | 4.1, 0.6 | M | **R7.8** |
| 4.3 | Per-source cache with TTLs, key on rounded coords + params, `{hit, ageMs}` returned into `Provenance`; `TestClock` tests for expiry. | 4.1, 1.2 | L | **R7.3** |
| 4.4 | Retry policy: idempotent GETs, transport and 5xx only, ≤2 attempts with exponential backoff, never on 4xx — asserted on a virtual clock. | 4.1 | M | **R7.5** |
| 4.5 | Circuit breaker per source with threshold and cooldown; `SourceCircuitOpen` while open; state reported in health. | 4.4 | L | **R7.6** |
| 4.6 | Rate-limit handling: required identifying headers per source, `SourceRateLimited` carrying the reset time where the upstream reports one. | 4.1, 0.1 | M | **R7.4** |
| 4.7 | Response size cap enforced while reading the body, `UpstreamTooLarge` rather than an unbounded buffer. | 4.1 | M | **R7.10** |
| 4.8 | Tile proxy route with server-side key injection and tile-level caching. | 4.3 | M | R7.9, R2.4 |
| 4.9 | Key redaction in every logged and traced upstream URL, asserted by test. | 4.1 | S | R9.1, N9 |
| 4.10 | Extend `GET /api/health` and add `GET /api/geo/providers`: per source — configured, reachable, circuit state, cache entries, data mode. | 4.5 | M | **R7.11**, R6.7 |

**Checkpoint 4:** with no keys and no network, every `/api/geo/*` route answers from fixtures or
fails with a named, remediable error; no route reaches an unlisted host; the breaker opens and closes
on a virtual clock.

---

## Phase 5 — Providers

Fixtures and the conformance suite come first. The suite is the definition of what a provider is;
writing it after the providers inverts the leverage, exactly as it would for a WebMCP adapter.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 5.1 | `adapters/geo/fixture/*` — a fixture provider for each of flood, places, alerts, routing, reading `fixtures/geo/<region>/<source>/<case>.json`, with `mode: 'fixture'` stamped into every `Provenance`. | 2.6, 2.7 | L | **R6.4**, **R8.4** |
| 5.2 | `conformance.test.ts` — shared, provider-parameterised: radius honoured, provenance complete on every datum, coverage stated, empty result distinguished from failure, abort respected, malformed payload rejected with the path named, oversized payload refused. | 5.1 | **XL** | **R6.5** |
| 5.3 | Fixture cases per source: normal, empty, stale, malformed, oversized. | 5.1 | M | R6.5, design §14.1 |
| 5.4 | `us/*` providers — flood (forecast + scenario), facilities, alerts; passes 5.2. | 5.2, 0.1 | **XL** | R2.*, R3.1, R4.*, R6.7 |
| 5.5 | `jp/*` providers — raster scenario flood via the Phase 3 pipeline, designated evacuation sites, JMA warnings with official English; passes 5.2. | 5.2, 3.8, 0.1 | **XL** | R2.4, R4.7, R6.7 |
| 5.6 | `eu/*` providers — pan-European flood forecast and CAP alerts, with coarse resolution stated in every result; passes 5.2. | 5.2, 0.1 | **XL** | R2.1, R4.1, R8.5 |
| 5.7 | Multi-source merge per region: per-source provenance preserved, same-class union, partial results when one source fails (`failedSources` populated). | 5.4–5.6 | L | **R6.9** |
| 5.8 | Staleness detection against each source's `expectedRefreshMs`, surfaced on the result. | 5.4–5.6, 1.2 | M | **R2.9** |

**Checkpoint 5:** the conformance suite passes for **every** provider including fixtures; each live
provider is skipped with a printed reason when its key is absent — never silently. Do not proceed
past a partial pass.

---

## Phase 6 — Routing

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 6.1 | `adapters/geo/routing/valhalla.ts` — request builder, costing map (`walk|bike|car`), response decode at the boundary, engine notes captured verbatim. | 2.2, 2.7 | L | **R3.3**, R3.9 |
| 6.2 | Exclusion areas: simplify to the engine's polygon and vertex limits, attach, mark `exclusions: 'applied'`. | 6.1, 3.3 | M | **R3.4** |
| 6.3 | Fallback path: on refusal or no-route-with-exclusions, retry **once** without them and mark `unavoided`; a test asserts the label and the summariser warning, because a silent drop here is the feature's worst artefact. | 6.2 | M | **R3.5**, ADR-6 |
| 6.4 | Crossing detection on the returned geometry via 3.5, for `applied` and `unavoided` routes alike. | 6.1, 3.5 | M | **R3.6** |
| 6.5 | Destination ranking: `clear` → `at_risk` → `unknown`, then distance; `at_risk` never dropped, only ranked. | 5.7, 1.4 | M | **R3.2** |
| 6.6 | Result caps: `limit` destinations (default 3), maneuver steps capped with the truncation stated. | 6.1 | S | R3.7 |
| 6.7 | Engine-absent path: unreachable, quota-exhausted, and circuit-open as three distinct errors, plus the straight-line fallback under its explicit "NOT ROUTES" heading. | 6.1, 4.5 | M | **R3.8** |
| 6.8 | Empty-radius path: no facility within the radius says so and names the radius; the search is never silently widened. | 6.5 | S | **R3.10** |

**Checkpoint 6:** with the fixture routing provider, three routes come back for the reference
scenario — one of them `unavoided` with its crossing count — and killing the engine produces the
labelled straight-line fallback rather than an empty result.

---

## Phase 7 — Snapshot service and summariser

The phase where the safety requirements stop being prose. Everything in design §13 is enforced here,
in one file each.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 7.1 | `app/hazard/snapshot.ts` — one location to flood + places + alerts, per-source partials, coverage and staleness aggregation, abort propagation. | 5.7, 5.8 | L | R6.9, R2.*, R4.* |
| 7.2 | `summarise.ts` — the fixed section order of design §6.1, with the banner, authority line, and fixture marker emitted from one code path. | 7.1, 1.2 | L | **R8.1**, **R8.2**, **R8.4** |
| 7.3 | Coverage-before-content rule, and `NONE` coverage rendering the explicit "this is not a statement that there is no flood risk" wording instead of a zone section. | 7.2 | M | **R2.8**, **R8.5** |
| 7.4 | Scenario-vs-forecast wording: a switch on `ZoneKind`, plus a test asserting the word "forecast" never appears in scenario output. | 7.2, 1.3 | M | **R2.2** |
| 7.5 | Verbatim upstream text fenced with its language tag, never interleaved with our prose; an injection fixture containing instruction-shaped text must not escape the fence. | 7.2 | M | **R4.6**, **R8.6** |
| 7.6 | 4 KB budget: truncate list sections only, never banner, coverage or staleness, and state what was dropped. | 7.2 | M | **N4**, R4.4 |
| 7.7 | Golden-file result tests per tool per region, plus a property test that no rendered result lacks a banner or an authority line. | 7.2–7.6 | L | design §13 |
| 7.8 | Stale, partial, fixture, and failed-source cases each asserted to be visible in the result text — not only in the trace. | 7.3, 5.8 | M | **R8.5** |

**Checkpoint 7:** the §13 safety table is fully asserted, and deleting any one marker from the
summariser fails a test with a message that names the requirement.

---

## Phase 8 — Tool set

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 8.1 | `toolsets/disaster.ts` — the seven tools of design §6 with flat schemas, defaults doing the work, annotations set honestly (`readOnlyHint: true`; `untrustedContentHint: true` where upstream text flows). | 7.2, 2.4 | L | R3.7 (chat spec), **R4.8**, **R8.6** |
| 8.2 | Register the set in `toolsets/index.ts`; confirm the existing name-legality, duplicate-name, and annotation-propagation tests cover it with no new assertions. | 8.1 | S | R3.8 (chat spec) |
| 8.3 | Location handling in every tool: explicit coordinates take precedence, otherwise resolve-with-TTL, with the position source stated in the result. | 8.1, 2.8 | M | **R1.3**, **R1.7** |
| 8.4 | Radius clamping surfaced in the result when it binds. | 8.1, 1.1 | S | **R1.9** |
| 8.5 | `focus_map` and `clear_map` against `MapPort`. | 8.1, 2.4 | S | R5.3 |
| 8.6 | Native-tool-call check against the local model (`gemma4:e4b`): every schema round-trips, and a two-tool turn completes; record the observed behaviour in the spec if it does not. | 8.1 | M | C, design §6 |

**Checkpoint 8:** with fixtures and the scripted driver, one turn drives `flood_forecast` →
`evacuation_routes` and every step is legible in the trace.

---

## Phase 9 — Map surface

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 9.1 | `adapters/map/maplibre.ts` implementing `MapPort`; the only module importing `maplibre-gl`. | 2.4, 0.3 | L | R5.1, R5.5 |
| 9.2 | `ui/map/MapPane` in the existing shell, with the five layers of design §9, each individually toggleable. | 9.1 | L | **R5.2** |
| 9.3 | Styling: hazard class encoded by pattern as well as colour, facility risk by shape as well as colour, `unavoided` routes dashed, crossings marked. | 9.2 | M | **R5.7** |
| 9.4 | Fit-to-geometry with padding, plus explicit focus and clear controls; camera respects `prefers-reduced-motion`. | 9.2 | M | R5.3, N7 |
| 9.5 | Attribution bar: every visible layer's required attribution, issuance and retrieval times; a component test asserts no visible layer lacks one. | 9.2, 1.2 | M | **R5.4**, **R8.10** |
| 9.6 | Text-equivalent list view of every layer, showing the same data the model saw. | 9.2 | M | **R5.8**, N7 |
| 9.7 | No-basemap mode: data layers draw over a plain background with the absence stated. | 9.1 | M | **R5.6** |
| 9.8 | No-WebGL mode: the list view replaces the map, tools unaffected. | 9.6 | M | **R5.9** |
| 9.9 | Persistent fixture-mode banner in the UI, unmissable and not dismissible while fixture mode is active. | 9.2 | S | **R8.4** |
| 9.10 | `data-testid` on every new interactive element, per the existing convention. | 9.2–9.9 | M | **R9.5** |
| 9.11 | Keyboard operability and live-region announcement for layer updates. | 9.2–9.10 | M | **N7** |
| 9.12 | English and Japanese UI strings; upstream content always in its source language. | 9.2 | M | **N8** |

**Checkpoint 9:** the reference scenario is fully legible on the map, and equally legible with the
map turned off — same facts, both routes.

---

## Phase 10 — Observability, fixtures, scenarios

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 10.1 | New trace event kinds from design §12, on the existing envelope, with durations from the existing spans. | 7.1, 4.1 | L | **R9.1** |
| 10.2 | Verbatim upstream body capture, truncated with the truncation marked. | 2.7, 10.1 | M | **R9.2** |
| 10.3 | Coordinate redaction in the trace sink and in `.traces/` export, with the full-precision opt-in. | 1.7, 10.1 | M | **R8.7** |
| 10.4 | Debug handle additions: `setLocation`, `getMapLayers`, `getLayerGeoJSON`, `setDataMode`, `listProviders`, `getCacheStats`. | 10.1, 9.1 | L | **R9.3** |
| 10.5 | Fixture recording script: capture from live upstreams, redact keys and coordinates, write `fixtures/geo/<region>/<source>/<case>.json` with capture time and upstream URL. | 5.3 | L | **R10.1** |
| 10.6 | The reference scenario `jp/tokyo-flood` of design §14.2, replaying headlessly in under a second. | 10.4, 8.1 | L | **R9.4**, design §14.2 |
| 10.7 | One US and one EU scenario, each with a seeded source failure proving the partial-result path. | 10.6, 5.7 | L | **R6.9**, R9.4 |
| 10.8 | Session reset clears the resolved position and every map layer. | 10.4 | S | **R8.8** |

**Checkpoint 10:** an agent, with no browser permissions and no network, pins a location, forces
fixtures, runs a scenario, and asserts on the exact drawn GeoJSON — reading only
`window.__WEBMCP_DEBUG__` and `.traces/<id>.json`.

---

## Phase 11 — Documentation and close-out

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 11.1 | `docs/adding-a-region-provider.md`: the steps, the conformance bar, and the provenance obligations. | 5.2, 2.6 | M | **R10.2**, R6.8 |
| 11.2 | README section: sources per region, which need a key, what each licence requires, how to run with no key at all, and the amended offline stance (chat-spec N4 vs this feature's R7.1/N6). | 0.1, 9.7 | M | **R10.3**, §1.5 |
| 11.3 | Performance measurement against N1–N3 and N5, recorded with the machine and method. | 10.6 | M | **N1**, **N2**, **N3**, **N5** |
| 11.4 | Privacy check: assert no request or trace exceeds the permitted coordinate precision, and no third-party analytics is loaded. | 10.3 | M | **N9** |
| 11.5 | Licence and attribution review: every shipped source's obligations met in UI and docs; anything unmet removes the source. | 9.5, 0.1 | M | **R8.10** |
| 11.6 | Cross-browser check per N10, including the no-WebGL path. | 9.8 | M | **N10** |
| 11.7 | `traceability.md`: every `R*` mapped to a passing test, a verified manual check, or an honestly recorded gap. | all | L | §7 DoD |
| 11.8 | Record technical debt with rationale in `docs/tech-debt.md` — at minimum the legend transcription and the marching-squares edge resolution of design §7.2. | all | S | Boy-Scout |

**Checkpoint 11 — Definition of done:** `bun run check` green with no network and no keys; the
provider conformance suite green for every provider; three region scenarios replay headlessly; every
requirement traced; and a reviewer reading only a tool result can tell whether the data was live,
fixture, stale, partial, forecast, or scenario.

---

## Sequencing notes

**Critical path:** 0.1 → 1.2/1.3 → 2.7 → 5.1 → 5.2 → 7.2 → 7.7 → 10.6. Two of those decide whether
the feature is trustworthy rather than merely working: **5.2** (the conformance suite, which defines
what a provider must prove) and **7.2/7.7** (the summariser and its golden tests, where every safety
requirement is either enforced once or lost everywhere). Neither should be compressed under time
pressure; if something has to give, cut a region, not these.

**Parallelisable:** Phase 3 (geometry) is independent of Phase 4 (backend) — they meet at Phase 5.
The three regional provider tasks (5.4–5.6) are independent of each other once 5.2 lands. Phase 9
(map UI) needs only `MapPort` and can proceed against fixture snapshots while Phase 6 routing is
still in progress.

**Deliberate ordering choices.** The source survey (0.1) is first because a licence problem
discovered after writing a provider wastes the provider. Fixtures (5.1) precede every live provider
because the machine has no keys today, CI has no network ever, and a fixture path built afterwards is
always second-class — which is exactly how simulated data ends up mistaken for real. The summariser
(7.2) precedes the tool set (8.1) so that no tool ever has the opportunity to format its own result.

**Gating on Phase 0.1.** If the survey finds that a region has no source this project may lawfully
use, that region ships with the sources it can use and an explicit coverage gap, recorded in
`traceability.md` — not with a substitute from a neighbouring region (R6.3).

**Deferred, per requirements §8:** non-flood hazards, per-country European refinement, isochrones,
elevation-aware safety scoring, shelter capacity, transit and indoor routing, offline PWA, background
monitoring, crowd-sourced reports, and machine translation (excluded, not deferred).
