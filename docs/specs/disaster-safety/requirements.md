# Requirements — Disaster Safety Tool Set

- **Status:** Draft
- **Last updated:** 2026-08-29
- **Builds on:** [`docs/specs/webmcp-chat`](../webmcp-chat/requirements.md) — this feature is a tool
  set plus a map surface inside the existing playground, not a new application.
- **Spec baseline:** W3C WebMCP CG Draft Report, 2026-04-23 (inherited via `ToolHostPort`)

## 1. Introduction

The Disaster Safety tool set exposes three life-safety capabilities to a WebMCP agent, for users in
the **United States, Europe, and Japan**:

1. **Flood zone forecasting and visualisation** — flood-prone areas within 20 km of the user, drawn
   on a map.
2. **Evacuation route planning and visualisation** — routes to emergency shelters and safe public
   facilities within 20 km, drawn on the same map.
3. **Official alerts and advisories** — government announcements and disaster/weather warnings in
   force for the user's location.

The consumer of these tools is a language model. That fact shapes every requirement below in two
ways. First, a tool result is **text**: the map is a visible side effect, and the authoritative
answer the model reads must stand on its own without pixels. Second, and more importantly, **a model
will paraphrase whatever it is given**. So the system must never hand it anything it would be
dangerous to paraphrase: no interpolated hazard data, no silent staleness, no fixture data that
reads like live data, and no unlabelled absence of coverage.

### 1.1 Goals

1. Answer "am I in a flood-prone area, where do I go, and what have the authorities said" from
   authoritative regional sources, with provenance on every datum.
2. Make the spatial reasoning visible — on a map for a human, as text and as inspectable GeoJSON for
   an agent.
3. Keep regional data-source churn confined to one provider module per source, the way WebMCP spec
   churn is confined to one adapter.
4. Remain fully exercisable offline, from recorded fixtures, with fixture data unmistakable as such.

### 1.2 Non-goals

- Replacing or competing with official warning channels. This is decision support; the authority of
  record is always the issuing agency.
- Hazards other than flooding (earthquake, tsunami, landslide, wildfire) — see [Deferred](#8-deferred-scope).
- Push notification, background monitoring, or any behaviour while the page is not open.
- Regions outside the US, Europe, and Japan. Those must fail explicitly, not degrade quietly.
- Indoor routing, transit routing, or capacity-aware shelter assignment.

### 1.3 Glossary

| Term | Meaning |
| --- | --- |
| **Forecast zone** | A time-bounded prediction of inundation, valid over a stated window. |
| **Scenario zone** | A planning hazard map — inundation under an assumed design event, with no valid-time. Not a forecast. |
| **Provider** | An implementation of one data port against one upstream source (e.g. NWS alerts). |
| **Region bundle** | The set of providers selected for a resolved region (`us`, `eu`, `jp`). |
| **Provenance** | Source id, upstream URL, issuance time, retrieval time, licence/attribution, live-or-fixture. |
| **Fixture mode** | Serving recorded upstream responses instead of calling the network. |
| **Safe facility** | An officially designated evacuation shelter or public facility in the region's own dataset. |
| **Vertex budget** | The maximum polygon vertex count a consumer (map layer, routing engine) will accept. |

### 1.4 Requirement conventions

EARS phrasing (`WHEN…SHALL`, `IF…THEN…SHALL`, `WHILE…SHALL`, `WHERE…SHALL`), one verifiable
criterion per row, stable `R<n>.<m>` ids referenced by `design.md` and `tasks.md`.

### 1.5 Relationship to the webmcp-chat spec

This feature **inherits** the existing requirements unchanged: the agent loop (R1), the selector
(R2), the tool-set contract (R3.5–R3.8), observability (R5), the adapter seam (R6), the Effect error
model (R7), and the backend rules (R8) of [`webmcp-chat`](../webmcp-chat/requirements.md). Where this
document says "trace event" or "tagged error" it means those mechanisms, extended.

Two inherited constraints are **amended**, and the amendment is the price of the feature:

| Inherited | Amendment |
| --- | --- |
| `webmcp-chat` N4 — no requests to third-party origins at runtime | Amended by **R7.1** and **N6**: third-party requests are permitted, but only from the backend, only to an explicit allowlist, and never in tests or fixture mode. The frontend still reaches no third-party origin except map tiles, which R7.9 governs. |
| `webmcp-chat` N5 — secrets from the environment only | Unchanged, and extended by **R7.7** to the new upstream credentials. |

## 2. Functional requirements

### R1 — Location resolution and consent

**As a** user in a flood-threatened area, **I want** the tools to know where I am without my typing
coordinates, **so that** an answer takes one sentence rather than a form.

| ID | Criterion |
| --- | --- |
| R1.1 | WHEN a location-dependent tool is invoked without explicit coordinates, THE SYSTEM SHALL resolve the current position through the HTML5 Geolocation API with an explicit timeout and `maximumAge`, and SHALL NOT call any provider before a position is resolved. |
| R1.2 | IF the Geolocation API reports permission denied, position unavailable, or timeout, THEN THE SYSTEM SHALL fail with a distinct tagged error per case, each carrying a remedy the user can act on, and SHALL state that coordinates may be supplied explicitly instead. |
| R1.3 | THE SYSTEM SHALL accept explicit `latitude` and `longitude` on every location-dependent tool, and those SHALL take precedence over the Geolocation API. |
| R1.4 | THE SYSTEM SHALL expose a pinned-location override through the debug handle and the URL configuration, so a scenario is reproducible on a machine that cannot move. |
| R1.5 | THE SYSTEM SHALL reuse a resolved position for a configurable TTL (default 60 s) rather than re-prompting for each tool call within one turn, and SHALL record each reuse as such. |
| R1.6 | THE SYSTEM SHALL round coordinates to at most 4 decimal places (≈11 m) before they leave the browser, SHALL round to 3 decimal places (≈110 m) for area queries that do not need precision, and SHALL record the precision actually sent. |
| R1.7 | Every location-derived tool result and trace event SHALL carry the coordinates used, the reported accuracy radius, and the position source (`geolocation`, `explicit`, or `pinned`). |
| R1.8 | IF the page is not a secure context, THEN THE SYSTEM SHALL say so explicitly rather than surfacing a bare Geolocation failure. |
| R1.9 | THE SYSTEM SHALL clamp any requested radius to the range 1–20 km, defaulting to 20 km, and SHALL state in the result when a requested value was clamped. |

### R2 — Flood zone forecasting

**As a** user, **I want** to know which areas near me are predicted to flood, **so that** I can
judge whether my location and my route are exposed.

| ID | Criterion |
| --- | --- |
| R2.1 | THE SYSTEM SHALL return the flood-prone areas intersecting a circle of the requested radius around the location, as polygon features in WGS84, from the region's provider bundle. |
| R2.2 | THE SYSTEM SHALL label every zone as `forecast` (time-bounded, with `validFrom`/`validTo`) or `scenario` (a planning hazard map with a stated design event and no valid-time), and SHALL NOT describe a scenario zone as a forecast in any result text. |
| R2.3 | Every zone SHALL carry a hazard class, a depth band in metres where the source publishes one, the issuing source id, the upstream URL, the issuance time, the retrieval time, and the licence/attribution string. |
| R2.4 | WHERE a provider publishes raster inundation tiles rather than vector features, THE SYSTEM SHALL fetch only the tiles intersecting the query circle, classify pixels against the source's published legend, and vectorise the classified pixels into polygons. |
| R2.5 | THE SYSTEM SHALL cap the number of tiles fetched per query (default 64) and SHALL state in the result when analysis was truncated by that cap, naming the fraction of the circle actually covered. |
| R2.6 | THE SYSTEM SHALL clip zones to the query circle, merge overlapping zones of the same class, and simplify geometry to a stated vertex budget, and SHALL report the vertex counts before and after simplification. |
| R2.7 | THE SYSTEM SHALL report, in the result text: the zone count by class, the maximum depth band present, whether the user's own position falls inside a zone, and the distance and compass bearing to the nearest zone edge. |
| R2.8 | IF the providers hold no data covering the location, THEN THE SYSTEM SHALL return an explicit "no coverage" result that is textually distinct from "no flood risk found", and SHALL NOT infer, interpolate, or model zones itself. |
| R2.9 | IF the newest issuance is older than the source's expected refresh interval, THEN THE SYSTEM SHALL mark the result stale, stating the issuance age and the expected interval. |
| R2.10 | THE SYSTEM SHALL expose a point-in-zone check reusable for any coordinate (a shelter, a route vertex), returning the containing zone's class and depth band or an explicit miss. |
| R2.11 | THE SYSTEM SHALL accept an optional forecast horizon in hours (default 24, maximum the source publishes) and SHALL state the horizon actually served when it differs from the one requested. |

### R3 — Evacuation route planning

**As a** user, **I want** routes to places I can actually go, **so that** I am not choosing a
destination from a map under stress.

| ID | Criterion |
| --- | --- |
| R3.1 | THE SYSTEM SHALL find officially designated shelters and safe public facilities within the requested radius, from the region's own facility dataset, each with name, category, coordinates, straight-line distance, compass bearing, and provenance. |
| R3.2 | THE SYSTEM SHALL evaluate every candidate destination against the current flood zones and SHALL mark each `clear`, `at_risk` (inside a zone), or `unknown` (no flood coverage), ranking `clear` destinations above `at_risk` ones and never silently dropping an `at_risk` destination. |
| R3.3 | THE SYSTEM SHALL compute routes with the Valhalla routing engine, defaulting to pedestrian costing, and SHALL support bicycle and automobile costing as an explicit choice. |
| R3.4 | THE SYSTEM SHALL pass the simplified flood polygons to the routing engine as exclusion areas, within the engine's documented limits on polygon count and vertices. |
| R3.5 | IF the routing engine rejects the request because of the exclusion areas, or returns no route with them applied, THEN THE SYSTEM SHALL retry once without exclusions and SHALL label the resulting route `unavoided`, stating that it may cross a flood zone. |
| R3.6 | THE SYSTEM SHALL test every returned route geometry against the flood zones, and SHALL report the number of crossings and the distance along the route to the first crossing. |
| R3.7 | THE SYSTEM SHALL return at most a configurable number of routes (default 3) to distinct destinations, each with total distance, estimated duration, the destination's risk state, and a maneuver summary capped at a stated number of steps. |
| R3.8 | IF the routing engine is unreachable or its quota is exhausted, THEN THE SYSTEM SHALL fail with a distinct tagged error per case and SHALL fall back to a straight-line distance and bearing list, explicitly labelled as **not a route** and not usable for navigation. |
| R3.9 | THE SYSTEM SHALL state the routing engine's own assumptions in the result — costing model, that road closures and flood damage are not represented in the road network, and the data vintage where the engine reports one. |
| R3.10 | IF no safe facility exists within the radius, THEN THE SYSTEM SHALL say so explicitly, name the radius searched, and SHALL NOT widen the search silently. |
| R3.11 | THE SYSTEM SHALL draw as a route only geometry that follows a road network, SHALL verify the engine's geometry against that criterion rather than accepting the engine's claim, and IF no candidate to a destination follows a road network THEN THE SYSTEM SHALL report that destination as a straight-line distance and bearing under R3.8 and SHALL NOT draw it. |
| R3.12 | THE SYSTEM SHALL offer several route candidates where the engine finds them, ranked by how much of each route's length runs through flood water and then by distance, SHALL present the leader as the recommendation, and SHALL highlight exactly one candidate at a time while keeping the others visible and plainly secondary. |

### R4 — Official alerts and advisories

**As a** user, **I want** the actual government warnings, **so that** I am acting on the authority's
words rather than a summary of them.

| ID | Criterion |
| --- | --- |
| R4.1 | THE SYSTEM SHALL retrieve the alerts and advisories in force for the location from the region's authoritative government source. |
| R4.2 | THE SYSTEM SHALL normalise every alert to a CAP-aligned shape: identifier, event, severity, urgency, certainty, headline, description, instruction, onset, effective, expires, sender, area description, language, and source URL. |
| R4.3 | THE SYSTEM SHALL select alerts whose area geometry contains the location or intersects the query radius, and WHERE an alert has no geometry, SHALL match it by the administrative area code the source publishes. |
| R4.4 | THE SYSTEM SHALL order alerts by severity then onset, cap the number returned (default 10), and state how many were withheld by the cap. |
| R4.5 | THE SYSTEM SHALL exclude expired alerts and SHALL state the count excluded, together with the retrieval time that "expired" is relative to. |
| R4.6 | THE SYSTEM SHALL return the official headline and instruction text verbatim and SHALL NOT paraphrase, translate, or summarise them inside the tool. |
| R4.7 | THE SYSTEM SHALL return alert text in the source language, and WHERE the source itself publishes an official translation, SHALL return that too, marked as the source's own. THE SYSTEM SHALL NOT machine-translate alert text. |
| R4.8 | THE SYSTEM SHALL annotate the alerts tool `untrustedContentHint: true` and SHALL delimit upstream text in the tool result so that it cannot be read as instructions addressed to the model. |
| R4.9 | IF no alerts are in force, THEN THE SYSTEM SHALL return an explicit "none in force as of `<time>` for `<area>`" result, textually distinct from a retrieval failure. |
| R4.10 | Every alert SHALL carry its issuing authority and a link to the authority's own page, so a human can verify it at the source. |

### R5 — Map visualisation

| ID | Criterion |
| --- | --- |
| R5.1 | THE SYSTEM SHALL render a MapLibre GL JS map as a page surface, and the flood, shelter, and route tools SHALL update it as a visible side effect of the tool call. |
| R5.2 | THE SYSTEM SHALL maintain distinct, individually toggleable layers for: user position and accuracy circle, query radius, flood zones styled by hazard class, safe facilities styled by risk state, and routes. |
| R5.3 | WHEN a tool produces new geometry, THE SYSTEM SHALL fit the viewport to that geometry with padding, and SHALL provide an explicit control and tool to re-focus or clear the map. |
| R5.4 | WHILE any data layer is visible, THE SYSTEM SHALL display the attribution and licence string of every source contributing to it, together with the issuance and retrieval times. |
| R5.5 | THE SYSTEM SHALL make the exact GeoJSON of every rendered layer readable through the debug handle, so an agent can assert on what was drawn without reading pixels. |
| R5.6 | IF basemap tiles are unavailable — offline, fixture mode, or a missing key — THEN THE SYSTEM SHALL still draw all data layers over a plain background and SHALL state that the basemap is absent. |
| R5.7 | THE SYSTEM SHALL encode hazard class by more than colour alone, and its palette SHALL be legible under the common colour-vision deficiencies. |
| R5.8 | THE SYSTEM SHALL provide a text-equivalent list view of every layer's contents, and the tool result SHALL name each layer it updated and the feature count in it. |
| R5.9 | IF WebGL is unavailable, THEN THE SYSTEM SHALL degrade to the list view with an explicit message, and the tools SHALL continue to return their full textual results. |

### R6 — Regional data providers

**As a** maintainer, **I want** a new country or a changed upstream to be one module, **so that** a
source deprecation is a contained edit.

| ID | Criterion |
| --- | --- |
| R6.1 | THE SYSTEM SHALL define internal ports in its own vocabulary for flood data, safe facilities, routing, alerts, and geolocation, and no module outside `src/adapters/geo/**` SHALL name an upstream host, endpoint path, or vendor payload shape. |
| R6.2 | THE SYSTEM SHALL resolve the region (`us`, `eu`, `jp`) from the coordinates, and SHALL record which rule matched. |
| R6.3 | IF the location falls outside the supported regions, THEN THE SYSTEM SHALL fail with a `RegionUnsupported` error naming the coordinates, the supported regions, and the fact that no provider was consulted — and SHALL NOT fall back to a provider from another region. |
| R6.4 | THE SYSTEM SHALL ship a fixture provider for every port, serving recorded upstream responses, selectable at runtime, and SHALL use fixture providers by default in the automated test suite. |
| R6.5 | THE SYSTEM SHALL run one shared conformance suite against every provider of a port, including the fixture providers, so a new provider is proven equivalent before it can be selected. |
| R6.6 | THE SYSTEM SHALL validate every upstream payload at the boundary against a schema, and IF a payload does not conform, THEN THE SYSTEM SHALL fail with a tagged error naming the offending path and SHALL NOT pass unvalidated data into the domain. |
| R6.7 | Every provider SHALL declare the upstream API version or dataset vintage it targets, a link to that upstream's documentation, and its licence and attribution requirements, and THE SYSTEM SHALL display them for every active provider. |
| R6.8 | Adding a provider or a region bundle SHALL require one new module and one registry entry, with no change to domain, tool set, UI, or agent-loop code. |
| R6.9 | IF one provider in a bundle fails while others succeed, THEN THE SYSTEM SHALL return the partial result, naming the failed source and what is therefore missing, rather than failing the whole call. |

### R7 — Backend proxy, credentials, and upstream discipline

| ID | Criterion |
| --- | --- |
| R7.1 | THE SYSTEM SHALL route every third-party data request through the Hono backend, and the browser SHALL hold no upstream credential. |
| R7.2 | THE SYSTEM SHALL validate every new route's request at the boundary and SHALL return `400` with a structured body naming the invalid fields. |
| R7.3 | THE SYSTEM SHALL cache upstream responses with a per-source TTL, keyed on the rounded coordinates and query parameters, and SHALL record on every result whether it was a cache hit and the age of the cached data. |
| R7.4 | THE SYSTEM SHALL send the identifying headers each upstream requires, SHALL respect documented rate limits, and IF a limit or quota is exceeded, THEN SHALL fail with a distinct tagged error naming the source and the reset time where the upstream reports one. |
| R7.5 | THE SYSTEM SHALL apply a per-source timeout and SHALL retry only idempotent requests that failed at the transport level or with a 5xx status, at most twice with exponential backoff, and never on a 4xx. |
| R7.6 | WHEN a source fails a configurable number of consecutive times, THE SYSTEM SHALL fail fast for a cooldown period rather than calling it, and SHALL report the source as circuit-open in health and in tool results that needed it. |
| R7.7 | THE SYSTEM SHALL read every upstream base URL, key, and limit from environment variables with documented defaults, SHALL fail fast at startup on a malformed value naming the variable, and SHALL start successfully with no keys configured — serving fixtures and saying so. |
| R7.8 | THE SYSTEM SHALL only issue outbound requests to hosts on a configured allowlist, and SHALL refuse, log, and surface any request to a host outside it. |
| R7.9 | WHERE the frontend loads map tiles directly from a tile host, THAT host SHALL be on the allowlist, SHALL be named in the README, and its key SHALL be delivered by the backend rather than embedded in the bundle. |
| R7.10 | THE SYSTEM SHALL cap the size of an accepted upstream response and SHALL fail with a named error rather than buffering an unbounded body. |
| R7.11 | `GET /api/health` SHALL additionally report, per source: configured or not, reachable or not, circuit state, and cache entry count — without failing the request when a source is down. |

### R8 — Safety, trust, and privacy

**This section is the reason the feature is different from the rest of the playground.** Every
criterion here exists because a plausible-sounding wrong answer about flooding is worse than no
answer.

| ID | Criterion |
| --- | --- |
| R8.1 | Every tool result SHALL open with a one-line banner naming what the result is, its source, its retrieval time, and whether it is live or fixture data. |
| R8.2 | Every tool result SHALL state that it is decision support and SHALL name the authority whose instructions take precedence in that region. |
| R8.3 | THE SYSTEM SHALL NOT generate, interpolate, extrapolate, or infer hazard geometry, depths, alert text, or shelter status that the provider did not supply. |
| R8.4 | WHILE fixture mode is active, THE SYSTEM SHALL mark every tool result with an unmissable `SIMULATED DATA — NOT REAL` marker and SHALL display a persistent banner in the UI. |
| R8.5 | IF a result is stale, partially covered, truncated by a cap, or missing a failed source's contribution, THEN the result SHALL say so in its banner or its first section — never only in the trace. |
| R8.6 | THE SYSTEM SHALL treat all upstream free text as untrusted content: delimited in tool results, escaped in the UI, and never interpreted as instructions. |
| R8.7 | THE SYSTEM SHALL redact coordinates to 3 decimal places in exported traces and in traces written to disk by default, and SHALL require an explicit opt-in to record full precision. |
| R8.8 | THE SYSTEM SHALL NOT persist a resolved position beyond the page session, and the session reset control SHALL clear it. |
| R8.9 | IF every provider needed for a request fails, or the region is unsupported, THEN THE SYSTEM SHALL return an explicit inability to advise, naming what failed and what the user should do instead — and SHALL NOT answer from the model's own knowledge. |
| R8.10 | THE SYSTEM SHALL record, for every source in use, its licence and required attribution, and SHALL display attributions wherever that source's data is shown. |

### R9 — Observability for this feature

Extends `webmcp-chat` R5; the mechanisms are inherited, the events are new.

| ID | Criterion |
| --- | --- |
| R9.1 | THE SYSTEM SHALL emit typed trace events for: location resolution, region resolution, each provider call (with upstream URL, key redacted, status, byte count, cache hit and age), tile fetch and classification, each geometry operation (with feature and vertex counts in and out), routing requests including whether exclusions were applied, map layer updates, staleness detection, and fixture service. |
| R9.2 | THE SYSTEM SHALL record the verbatim upstream response for each provider call, truncated to a stated cap with the truncation marked. |
| R9.3 | THE SYSTEM SHALL extend the debug handle with, at minimum: `setLocation`, `getMapLayers`, `getLayerGeoJSON`, `setDataMode('live'\|'fixture')`, `listProviders`, and `getCacheStats`. |
| R9.4 | A recorded fixture set SHALL reproduce a complete scenario headlessly and deterministically, with no network and no browser geolocation. |
| R9.5 | THE SYSTEM SHALL attach `data-testid` attributes to every new interactive element, following the existing `<area>-<element>-<qualifier>` convention. |

### R10 — Developer experience

| ID | Criterion |
| --- | --- |
| R10.1 | THE SYSTEM SHALL provide a script that records fixtures from live upstreams into the repository, redacting keys and coordinates, so fixtures are refreshed rather than hand-written. |
| R10.2 | THE SYSTEM SHALL document, in `docs/adding-a-region-provider.md`, the steps and the conformance bar for a new provider or region. |
| R10.3 | The README SHALL state which upstreams are used per region, which need a key, what each licence requires, and how to run the feature with no key at all. |
| R10.4 | `bun run check` SHALL remain green with no network access and no API keys configured. |

### R11 — Place name resolution

**As a** user asking about somewhere other than where I am standing — my daughter's school, the
station I am about to walk to — **I want** to name it, **so that** I do not have to produce
coordinates for it myself, and neither does the model from memory.

| ID | Criterion |
| --- | --- |
| R11.1 | THE SYSTEM SHALL provide a tool that resolves a natural-language place name, in any language the source indexes, to WGS84 coordinates, and SHALL return the coordinates at the precision required by R1.6. |
| R11.2 | THE SYSTEM SHALL return the candidate matches ranked, each carrying its own name, enough address context to distinguish it from a like-named place, its kind, and its provenance. |
| R11.3 | IF no place matches, THEN THE SYSTEM SHALL say so and SHALL state that no coordinates were produced — and SHALL NOT return an approximate, nearest, or invented location. |
| R11.4 | IF two or more candidates answer the query about equally well AND they lie more than 1 km apart, THEN THE SYSTEM SHALL mark the result ambiguous and SHALL NOT nominate one of them as the coordinates to act on. Candidates closer together than that are two names for one place at the resolution every other tool works at, and SHALL NOT be reported as a choice. |
| R11.5 | WHERE a match denotes an area rather than a point, THE SYSTEM SHALL state that its coordinates are a label point within that area and not a specific address. |
| R11.6 | THE SYSTEM SHALL state, for every match, whether it falls inside a supported region and which authority covers it, so a caller learns before a second tool call that no hazard data exists for it. |
| R11.7 | IF the query is empty or is itself a coordinate pair, THEN THE SYSTEM SHALL fail with a tagged error naming the problem rather than issuing a search. |
| R11.8 | The fixture geocoder SHALL resolve only names it actually holds, and SHALL NOT synthesise a location for an unknown name in the way the fixture providers for area-based data legitimately may. |

## 3. Non-functional requirements

| ID | Criterion |
| --- | --- |
| N1 | In fixture mode, each tool SHALL complete end to end in under 500 ms on the reference machine, so the agent loop stays testable at speed. |
| N2 | Live-mode budgets, measured warm-cache: flood forecast under 3 s, alerts under 2 s, routing under 4 s for 3 destinations. Cold-cache times SHALL be reported in the result rather than silently exceeded. |
| N3 | Geometry processing — clip, merge, simplify, point-in-polygon, line intersection — SHALL handle 5 000 input features within 250 ms, and SHALL run without blocking the UI thread for longer than 50 ms at a time. |
| N4 | Tool result text SHALL stay under 4 KB, because the consumer is an 8B local model with a finite context; anything larger SHALL be summarised with the full data available through the map layer and the debug handle. |
| N5 | A rendered layer SHALL stay within 20 000 vertices after simplification, and the flood layer SHALL remain interactive at 60 fps on the reference machine. |
| N6 | The full test suite and the development loop SHALL run with no network access, using fixtures; no test SHALL contact a third-party origin. |
| N7 | The UI SHALL be keyboard operable, SHALL provide the text equivalents of R5.8 to assistive technology, and SHALL respect `prefers-reduced-motion` for map camera movement. |
| N8 | Labels and UI strings SHALL be available in English and Japanese; upstream content SHALL always be shown in its source language per R4.7. |
| N9 | Coordinates SHALL never be sent to a third party at higher precision than R1.6 permits, and no third-party analytics or telemetry SHALL be loaded. |
| N10 | The feature SHALL target current Chrome, Edge, Firefox, and Safari, and SHALL degrade per R5.9 where WebGL is absent. |

## 4. Constraints

- **Map rendering:** MapLibre GL JS. **Spatial analysis:** Turf.js. **Routing:** Valhalla, reached
  through a hosted provider (Stadia Maps) or a self-hosted instance, selected by configuration.
- **Location:** the HTML5 Geolocation API, which requires a secure context; `http://localhost` qualifies.
- The existing stack is retained unchanged: Bun, Vite, React 19, TypeScript, Effect, Hono, Tailwind,
  Vitest — and the existing ports, trace, and error mechanisms are extended, not duplicated.
- The model driving these tools is a local 8B model (`gemma4:e4b` via Ollama) using native tool
  calls. Tool count, schema depth, and result length are budgeted for that, not for a frontier model.
- Every upstream is subject to its own licence and terms of use; a source whose terms this project
  cannot satisfy is not shipped, regardless of data quality.

## 5. Assumptions

1. No upstream API key is available on the development machine at the time of writing, so fixture
   mode must carry development the way the scripted LLM driver already does.
2. Regional sources differ in kind, not just in endpoint: some publish time-bounded forecasts, some
   publish scenario hazard maps, some publish raster tiles rather than vectors. The domain must hold
   all three without flattening the difference.
3. European coverage is pan-European and coarse at the bundle level; national services are finer but
   heterogeneous, and per-country refinement is an extension point rather than a launch requirement.
4. Upstream endpoints and payload shapes will change during this project's life — the same assumption
   the WebMCP adapter seam already makes.
5. Users may invoke these tools when they are not in danger, so results must be equally clear about
   the "nothing is happening" case.

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Model paraphrases a scenario map as a forecast | Dangerously wrong advice | R2.2 labelling, R8.1–R8.3 banners, verbatim-only alert text (R4.6) |
| Fixture data mistaken for live data | Same, in demos | R8.4 unmissable marker in every result and a persistent UI banner |
| "No coverage" read as "no risk" | False reassurance | R2.8 distinct wording, asserted by test |
| Upstream deprecates or changes shape | Feature silently degrades | R6.6 boundary validation, R6.7 declared vintage, R6.9 partial results |
| Routing quota exhausted mid-incident | No routes when they matter | R7.3 caching, R7.6 circuit breaker, R3.8 explicit labelled fallback |
| Raster tile classification is wrong | Wrong depths | R2.4 legend-driven classification, fixtures with known expected output, vertex/area assertions |
| Coordinates leak through traces or upstreams | Privacy harm | R1.6 precision caps, R8.7 redaction by default |
| Payloads blow the local model's context | Loop fails opaquely | N4 size budget, R2.6 simplification, R3.7/R4.4 caps |

## 7. Acceptance — definition of done

The feature is complete when: every `R*` criterion has a passing automated test or a documented
manual check recorded in `traceability.md`; the provider conformance suite passes for every provider
of every port including fixtures; `bun run check` is green with no network and no keys; a full
three-tool scenario replays headlessly from fixtures for each of the three regions; and a reviewer
reading only a tool result can tell, without opening the trace, whether the data was live, fixture,
stale, partial, forecast, or scenario.

## 8. Deferred scope

Hazards beyond flooding (earthquake, tsunami, landslide, wildfire); per-country European provider
refinement beyond the pan-European bundle; isochrone-based reachability; elevation-aware route
safety scoring; shelter capacity and occupancy; transit and indoor routing; offline PWA operation
with pre-cached tiles; background monitoring and push notification; crowd-sourced observations;
machine translation of alert text (deliberately excluded, not merely deferred — see R4.7).
