import { describe, expect, it } from 'vitest'
import { build, type Rollup } from 'vite'

/**
 * MapLibre does its own rendering work in a web worker, and picks that worker's URL at runtime from
 * its own `import.meta.url`. A bundler necessarily breaks that: the module it rewrites `import.meta`
 * for has no `maplibre-gl-worker.mjs` beside it. The worker then 404s and — with no thrown error and
 * nothing on the console — every GeoJSON source stays unloaded, so flood zones, shelters and routes
 * render nothing while the raster basemap still draws. The map looks alive and shows no data.
 *
 * `src/adapters/map/maplibre.ts` therefore imports the worker with `?worker&url` and hands the
 * resulting URL to `setWorkerUrl`. This asserts what that has to produce: a real emitted asset,
 * referenced by the app bundle, carrying the shared chunk the worker imports. A unit test cannot
 * see any of that — only the build output can.
 */
describe('MapLibre worker ships with the bundle', () => {
  it('emits a worker asset the app bundle points at', async () => {
    const result = (await build({
      logLevel: 'silent',
      build: { write: false, minify: false },
    })) as Rollup.RollupOutput | Array<Rollup.RollupOutput>

    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output)
    const names = outputs.map((o) => o.fileName)

    const worker = names.find((n) => n.includes('maplibre-gl-worker'))
    expect(worker, `no worker asset among: ${names.join(', ')}`).toBeDefined()

    // The app bundle must reference the emitted filename — a stale or unhashed reference is the
    // 404 this test exists to catch.
    const appCode = outputs
      .filter((o): o is Rollup.OutputChunk => o.type === 'chunk' && o.isEntry)
      .map((o) => o.code)
      .join('\n')
    expect(appCode).toContain(worker!.split('/').pop())

    // The worker imports `maplibre-gl-shared.mjs`; a verbatim asset copy would leave that dangling.
    const workerOut = outputs.find((o) => o.fileName === worker)
    const workerCode =
      workerOut?.type === 'chunk' ? workerOut.code : String((workerOut as Rollup.OutputAsset).source)
    expect(workerCode).not.toMatch(/from\s*["']\.\/maplibre-gl-shared\.mjs["']/)
    expect(workerCode.length).toBeGreaterThan(100_000)
  }, 120_000)
})
