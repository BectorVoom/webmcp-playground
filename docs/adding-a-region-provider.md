# Adding a New Region Provider to Disaster Safety

This guide explains how to add a new regional data provider (e.g. Taiwan, Canada, Australia) to the Disaster Safety toolset.

---

## 1. Implement Port Interfaces

Implement the four domain ports defined in `src/ports/`:

1. **`FloodDataPort`** (`src/ports/FloodData.ts`):
   - `zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError>`
   - Distinguish `forecast` vs `scenario` in `ZoneKind`.
   - Provide complete `Provenance` on every zone (including `sourceId`, `licence`, `attribution`, and `mode`).

2. **`PlacesPort`** (`src/ports/Places.ts`):
   - `facilitiesWithin(query: PlacesQuery): Effect.Effect<PlacesQueryResult, GeoError>`
   - Return designated emergency shelters and safe facilities.

3. **`AlertsPort`** (`src/ports/Alerts.ts`):
   - `alertsFor(query: AlertsQuery): Effect.Effect<AlertsQueryResult, GeoError>`
   - Preserve verbatim text from the issuing authority in its native language tag.

4. **`RoutingPort`** (`src/ports/Routing.ts`):
   - Use Valhalla or regional pedestrian routing with polygon exclusion areas and unavoided crossing detection.

---

## 2. Register Regional Bounding Box

In `src/adapters/geo/region.ts`, add the region definition to `REGION_RULES`:

```typescript
export const REGION_RULES: ReadonlyArray<RegionRule> = [
  // ...
  {
    id: 'tw',
    name: 'Taiwan',
    authority: 'Central Weather Administration (CWA) and local government',
    note: 'Taiwan hazard map coverage',
    bboxes: [[119.5, 21.8, 122.5, 25.5]],
  },
]
```

---

## 3. Create Fixture Datasets

Create mock fixture datasets under `fixtures/geo/<region>/`:
- `fixtures/geo/<region>/flood/normal.json`, `empty.json`, `stale.json`, `malformed.json`
- `fixtures/geo/<region>/places/normal.json`, `empty.json`, `stale.json`, `malformed.json`
- `fixtures/geo/<region>/alerts/normal.json`, `empty.json`, `stale.json`, `malformed.json`

Every fixture provider must stamp `mode: 'fixture'` into the `Provenance` of each returned record.

---

## 4. Bind in Provider Registry

In `src/adapters/geo/registry.ts`, register the region in `LIVE_BUNDLES` and `FIXTURE_BUNDLES`:

```typescript
export const LIVE_BUNDLES: BundleRegistry = {
  // ...
  tw: {
    flood: [new TwFloodProvider()],
    places: [new TwPlacesProvider()],
    alerts: [new TwAlertsProvider()],
    routing: new ValhallaRoutingProvider(),
  },
}
```

---

## 5. Add Allowed Hosts to Server Config

If the provider queries live upstream HTTP APIs, add the hostnames to `.env.example` and `server/config.ts` default `GEO_ALLOWED_HOSTS`:

```env
GEO_ALLOWED_HOSTS="api.weather.gov,cyberjapandata.gsi.go.jp,cwa.gov.tw,..."
```

---

## 6. Run Conformance Tests

Run the provider conformance suite to verify all invariants:

```bash
bun run test src/adapters/geo/conformance.test.ts
```

All invariants (radius adherence, complete provenance, coverage discrimination, safe error handling) must pass.
