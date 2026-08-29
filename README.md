# WebMCP Test Chat Page & Disaster Safety Assistant

A local playground for exercising the [WebMCP](https://webmachinelearning.github.io/webmcp/)
browser API, now featuring an authoritative **Disaster Safety** toolset for decision support during flood and extreme weather events.

The page acts as a **tool provider** — registering WebMCP tools with the browser's model-context registry — and embeds its own **agent** backed by a local or scripted LLM, with real-time MapLibre spatial visualization.

---

## Disaster Safety Subsystem

The Disaster Safety toolset provides four core emergency capabilities across the **United States**, **Europe**, and **Japan**:

1. **Flood Inundation & Hazard Mapping (`disaster.flood_forecast`)**: Scenario flood hazard zones (e.g. Japan GSI L2, FEMA NFHL) and river flood forecasts (e.g. NOAA NWS, Copernicus EFAS) with point-in-polygon user containment and nearest hazard edge proximity analysis.
2. **Designated Safe Shelters (`disaster.find_shelters`)**: Officially designated evacuation sites with spatial risk classification (`[CLEAR]`, `[AT RISK]`, `[UNKNOWN]`).
3. **Official Warnings & Advisories (`disaster.official_alerts`)**: Verbatim emergency warnings (JMA, NWS, MeteoAlarm) fenced with language tags to prevent prompt injection and hallucination.
4. **Evacuation Route Planning (`disaster.evacuation_routes`)**: Multi-modal pedestrian routing with flood exclusion zones, fallback unavoided crossing reports, and straight-line fallback.
5. **Interactive Map & Accessible List Surface (`disaster.focus_map`, `disaster.clear_map`)**: Toggleable spatial layers (`user-position`, `query-radius`, `flood-zones`, `facilities`, `routes`) rendered with MapLibre GL JS, with automatic text-equivalent list fallback for no-WebGL environments.

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

---

## Running Live Mode vs Fixture Mode

By default, the application runs in `fixture` mode using local, high-fidelity offline datasets (`fixtures/geo/*`).

To enable live upstream network fetching through the backend proxy:

```bash
# Copy configuration
cp .env.example .env

# Set data mode in .env
GEO_DATA_MODE=live
```

The backend proxy enforces:
- Strict host allowlist (`GEO_ALLOWED_HOSTS`)
- Circuit breakers per upstream host (`GEO_BREAKER_THRESHOLD`, `GEO_BREAKER_COOLDOWN_MS`)
- In-memory TTL caching with cache age inspection
- 5MB payload caps and URL API key redaction

---

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
- `bun run test src/toolsets/disaster.test.ts` — Disaster safety WebMCP tool definitions and execution
- `bun run test src/ui/map/MapPane.test.tsx` — MapPane layer toggles, legend, attribution, and text view
- `bun run test src/app/reference-scenario.test.ts` — End-to-end reference scenario integration test
