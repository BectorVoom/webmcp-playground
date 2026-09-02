# MapLibre GL JS Frontend Testing Guidelines

This document outlines the testing conventions and standards for MapLibre GL JS implementations on the frontend. The primary objective is to verify that map components, vector/raster layers, and dynamic features render deterministically and accurately according to specification.

---

## 1. Scope and Strategy Overview

Testing WebGL-rendered maps requires a tiered testing strategy. Standard DOM assertions alone cannot guarantee canvas correctness; therefore, testing is divided into three tiers:

```
                  ┌──────────────────────────────┐
                  │ Visual Regression / E2E      │  Canvas pixel comparison,
                  │ (Playwright / WebGL Browser) │  rendering complete check
                  ├──────────────────────────────┤
                  │ Functional Integration Tests │  queryRenderedFeatures,
                  │ (Component / Map API Level)  │  layers, sources & events
                  ├──────────────────────────────┤
                  │ Unit Tests (Business Logic)  │  GeoJSON transforms, style
                  │ (Vitest / Jest / JSDOM)      │  spec generators, utilities
                  └──────────────────────────────┘

```

| Test Type | Target Scope | Execution Environment | Tools / Runners |
| --- | --- | --- | --- |
| **Visual Regression** | Pixel-perfect canvas output, style rules, rendering diffs | Real headless browser with WebGL enabled | Playwright / Cypress + Pixelmatch |
| **Map State / API** | Layer presence, source data, filtered feature counts | Real browser or mock WebGL context | Playwright / Vitest + `@mapbox/mapbox-gl-mock` |
| **Logic & Transform** | Data mappers, filter generators, coordinate converters | JSDOM / Node.js | Vitest / Jest |

---

## 2. Deterministic Rendering Rules

To eliminate test flakiness and false positives in visual and integration tests, all map instances in test suites **must** satisfy the following constraints:

### 2.1 Disable Transitions and Animations

* Set map movement animations to `animate: false` or duration `0`.
* Disable style transition timers in the style specification or pass `fadeDuration: 0` to vector/raster sources.

```typescript
map.jumpTo({
  center: [139.6917, 35.6895],
  zoom: 12,
  bearing: 0,
  pitch: 0
});

```

### 2.2 Fix Viewport and Device Pixel Ratio

* Lock the viewport dimensions (e.g., `800x600 px`).
* Explicitly set `devicePixelRatio: 1` in the browser test context to avoid antialiasing discrepancies between local machines and CI runners.

### 2.3 Wait for Map Idle State

* Never assert against visual state immediately after calling a method or setting state.
* Always await the `idle` event, which ensures:
1. All vector/raster tiles in the viewport have finished downloading.
2. All style layers have completed their render pass to the WebGL canvas.



```typescript
await new Promise<void>((resolve) => {
  if (map.loaded() && map.areTilesLoaded()) {
    resolve();
  } else {
    map.once('idle', () => resolve());
  }
});

```

---

## 3. Visual Regression Testing Conventions

Visual snapshot tests ensure that map styles, symbology, colors, and layout properties render as expected.

### 3.1 Snapshot Isolation

* **Mock Remote Tile & Font Requests:** Route all tile requests (`.pbf`, raster tiles, glyphs, sprites) through a local mock server or static fixtures. External network dependencies are prohibited in CI test runs.
* **Mask Dynamic Overlays:** UI overlays containing timestamps, user avatars, or variable text must be masked or hidden before taking a canvas snapshot.

### 3.2 Threshold Configuration

* Use a normalized mismatch threshold between `0.1%` and `0.5%` (`maxDiffPixelRatio: 0.002`) to accommodate minor GPU driver rendering differences across operating systems.

### 3.3 Example: Playwright Visual Test

```typescript
import { test, expect } from '@playwright/test';

test.describe('MapLibre Layer Rendering', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept external vector tile/style endpoints with static fixtures
    await page.route('**/tiles/**', (route) => {
      route.fulfill({ status: 200, path: './tests/fixtures/sample-tile.pbf' });
    });
  });

  test('should correctly render choropleth layer on data load', async ({ page }) => {
    await page.goto('/map-view');

    // Wait until MapLibre fires the custom rendered indicator or 'idle' event
    await page.waitForFunction(() => {
      const mapInstance = (window as any).mapInstance;
      return mapInstance && mapInstance.loaded() && mapInstance.areTilesLoaded();
    });

    const mapCanvas = page.locator('.maplibregl-canvas');
    await expect(mapCanvas).toBeVisible();

    // Verify canvas visual match against baseline snapshot
    await expect(mapCanvas).toHaveScreenshot('choropleth-layer-baseline.png', {
      maxDiffPixelRatio: 0.002,
      animations: 'disabled'
    });
  });
});

```

---

## 4. Map State and Feature Inspection Conventions

When validating programmatic changes (filtering, layer toggling, feature selection), test through the MapLibre API using `queryRenderedFeatures` and layer inspection methods before or alongside visual snapshots.

### 4.1 Required Verifications per Layer Addition

Every layer rendering test must verify:

1. **Layer Existence & Order:** `map.getLayer(layerId)` is defined and positioned at the correct `beforeId` index.
2. **Visibility State:** `map.getLayoutProperty(layerId, 'visibility') === 'visible'`.
3. **Data Binding:** `map.getSource(sourceId)` contains the expected data or valid URL.
4. **Feature Query Verification:** `map.queryRenderedFeatures({ layers: [layerId] })` returns a non-empty list of features with expected properties.

### 4.2 Example: Feature & Style Assertion

```typescript
test('should filter visible points based on category filter', async () => {
  const layerId = 'pois-layer';

  // Apply filter
  map.setFilter(layerId, ['==', ['get', 'category'], 'hospital']);
  
  await new Promise<void>((resolve) => map.once('idle', () => resolve()));

  // Inspect rendered features inside the viewport
  const renderedFeatures = map.queryRenderedFeatures({
    layers: [layerId]
  });

  expect(renderedFeatures.length).toBeGreaterThan(0);
  for (const feature of renderedFeatures) {
    expect(feature.properties?.category).toBe('hospital');
  }
});

```

---

## 5. Mocking and Test Fixtures

### 5.1 Unit Tests (Headless / JSDOM)

* For unit tests that only verify event bindings, prop updates, or helper functions, mock the `maplibregl.Map` constructor.
* Do not attempt to initialize a real WebGL context inside JSDOM; rely on stub implementations.

```typescript
// Vitest / Jest mock pattern
vi.mock('maplibre-gl', () => {
  const MapMock = vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
    queryRenderedFeatures: vi.fn().mockReturnValue([]),
    loaded: vi.fn().mockReturnValue(true),
    remove: vi.fn()
  }));

  return { default: { Map: MapMock } };
});

```

### 5.2 Fixture Data Rules

* GeoJSON fixtures must be stored under `tests/fixtures/` and contain small, representative bounding boxes covering only the test viewport coordinates.
* Avoid full-size production datasets in the test suite to keep execution times under threshold.

---

## 6. CI/CD Execution & Snapshot Maintenance

1. **Dedicated Container for Baseline Generation:** All visual baseline snapshots must be generated inside a standard Docker container (matching CI architecture) to prevent cross-platform font and WebGL engine differences between macOS, Linux, and Windows.
2. **Snapshot Update Workflow:**
* Updating baselines requires explicit flag execution: `npm run test:visual -- -u`.
* Baseline changes must be reviewed in pull requests alongside visual diff artifacts.


3. **Failure Artifacts:** On visual test failure, CI must upload:
* The actual render (`actual.png`)
* The expected snapshot (`expected.png`)
* The visual diff highlighted image (`diff.png`)
