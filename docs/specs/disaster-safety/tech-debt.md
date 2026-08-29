# Technical Debt Log: Disaster Safety Subsystem

This document records architectural compromises, temporary stubs, and future refactoring opportunities noted during the implementation of the Disaster Safety extension.

---

## 1. Raster Contour Vectorization
- **Context:** `src/lib/geometry/contour.ts` implements a simplified marching-squares / flood fill approximation for converting GSI raster tiles to GeoJSON polygons on the client.
- **Future Enhancement:** For large multi-tile views, move heavy raster contour vectorization to a Web Worker or backend pre-vectorized GeoJSON tile pipeline (e.g. Mapbox Vector Tiles or PMTiles) to reduce client main-thread CPU time.

## 2. Dynamic Basemap Tile Styles
- **Context:** `src/adapters/map/maplibre.ts` uses an in-memory fallback style when no external vector tile server URL is configured (`GEO_BASEMAP_STYLE_URL`).
- **Future Enhancement:** Provide bundled offline vector styles and sprites for dark mode and high-contrast emergency display.

## 3. Real-time Multi-Language Alert Localization
- **Context:** JMA alerts in Japan provide Japanese text and official JMA English translations when published. When no official translation is provided by the issuing meteorological service, the system preserves verbatim native language without attempting machine translation (ADR-5).
- **Future Consideration:** When official translations are missing from non-English sources (e.g. German MeteoAlarm alerts), continue strictly adhering to ADR-5 to avoid catastrophic model hallucinations in safety-critical advisories.
