/**
 * Test support: a stand-in for MapLibre's `Map`.
 *
 * Extracted from `maplibre.test.tsx` so more than one suite can drive the adapter without a
 * second, subtly different copy of it. It keeps the constraints that actually bite: a source
 * cannot be removed while a layer references it, layer ids are unique, and `addLayer` silently
 * drops a layer whose source is missing (MapLibre fires an error event rather than throwing).
 * Without those rules a fake would pass on code that leaves the real map blank.
 *
 * It is not a rasteriser. `queryRenderedFeatures` returns the features of the source a layer is
 * bound to, which is enough to tell "reached the canvas" from "handed to the source" — the
 * distinction `inspectRendering` exists to make — but it is not proof of pixels. Only a real
 * WebGL browser can give that, and this repository has none.
 */
export class FakeMap {
  layers: Array<Record<string, unknown> & { id: string; source?: string }> = []
  sources = new Map<string, { data?: unknown; setData: (d: unknown) => void }>()
  handlers = new Map<string, Array<(e?: unknown) => void>>()
  styleLoaded = false
  droppedLayers: Array<string> = []
  fitCalls = 0
  removed = false

  readonly opts: Record<string, unknown>

  constructor(opts: Record<string, unknown>) {
    this.opts = opts
    const style = opts.style as { sources?: Record<string, unknown>; layers?: Array<{ id: string }> }
    if (style && typeof style === 'object') {
      for (const id of Object.keys(style.sources ?? {})) {
        this.sources.set(id, { setData: () => {} })
      }
      this.layers.push(...((style.layers ?? []) as Array<{ id: string }>))
    }
  }

  on(ev: string, a: unknown, b?: unknown) {
    const fn = (typeof a === 'function' ? a : b) as (e?: unknown) => void
    const key = typeof a === 'function' ? ev : `${ev}:${String(a)}`
    const arr = this.handlers.get(key) ?? []
    arr.push(fn)
    this.handlers.set(key, arr)
  }

  fire(ev: string, payload?: unknown) {
    for (const fn of this.handlers.get(ev) ?? []) fn(payload)
  }

  handlerCount(ev: string) {
    return (this.handlers.get(ev) ?? []).length
  }

  isStyleLoaded() {
    return this.styleLoaded
  }

  private checkLoaded() {
    if (!this.styleLoaded) throw new Error('Style is not done loading')
  }

  getSource(id: string) {
    return this.sources.get(id)
  }

  addSource(id: string, src: { data?: unknown }) {
    this.checkLoaded()
    if (this.sources.has(id)) throw new Error(`There is already a source with ID "${id}"`)
    const entry = { data: src.data, setData: (d: unknown) => void (entry.data = d) }
    this.sources.set(id, entry)
  }

  removeSource(id: string) {
    this.checkLoaded()
    const inUse = this.layers.find((l) => l.source === id)
    if (inUse) {
      throw new Error(`Source "${id}" cannot be removed while layer "${inUse.id}" is using it.`)
    }
    this.sources.delete(id)
  }

  getLayer(id: string) {
    return this.layers.find((l) => l.id === id)
  }

  addLayer(spec: Record<string, unknown> & { id: string; source?: string }) {
    this.checkLoaded()
    if (this.getLayer(spec.id) || (spec.source && !this.sources.has(spec.source))) {
      this.droppedLayers.push(spec.id)
      return
    }
    this.layers.push(spec)
  }

  removeLayer(id: string) {
    this.checkLoaded()
    const i = this.layers.findIndex((l) => l.id === id)
    if (i < 0) throw new Error(`The layer '${id}' does not exist`)
    this.layers.splice(i, 1)
  }

  moveLayer(id: string) {
    this.checkLoaded()
    const i = this.layers.findIndex((l) => l.id === id)
    if (i < 0) throw new Error(`The layer '${id}' does not exist`)
    const [layer] = this.layers.splice(i, 1)
    this.layers.push(layer!)
  }

  setLayoutProperty(id: string, key: string, value: unknown) {
    this.checkLoaded()
    const layer = this.getLayer(id)
    if (!layer) throw new Error(`The layer '${id}' does not exist`)
    layer.layout = { ...((layer.layout as object) ?? {}), [key]: value }
  }

  setPaintProperty(id: string, key: string, value: unknown) {
    this.checkLoaded()
    const layer = this.getLayer(id)
    if (!layer) throw new Error(`The layer '${id}' does not exist`)
    layer.paint = { ...((layer.paint as object) ?? {}), [key]: value }
  }

  getLayoutProperty(id: string, key: string) {
    const layer = this.getLayer(id)
    if (!layer) throw new Error(`The layer '${id}' does not exist`)
    return (layer.layout as Record<string, unknown> | undefined)?.[key]
  }

  /**
   * Stands in for the rasteriser: a layer draws the features of the source it is bound to, and
   * draws nothing once hidden. Enough to tell "reached the canvas" from "handed to the source",
   * which is the distinction the diagnostic exists to make.
   */
  queryRenderedFeatures(options?: { layers?: Array<string> }) {
    const ids = options?.layers ?? this.layers.map((l) => l.id)
    const out: Array<unknown> = []
    for (const id of ids) {
      const layer = this.getLayer(id)
      if (!layer) throw new Error(`The layer '${id}' does not exist`)
      if ((layer.layout as Record<string, unknown> | undefined)?.visibility === 'none') continue
      const source = layer.source ? this.sources.get(layer.source) : undefined
      const data = source?.data as { features?: Array<unknown> } | undefined
      out.push(...(data?.features ?? []))
    }
    return out
  }

  /**
   * The sprite atlas. Modelled because a `fill-pattern` naming an image the map does not hold
   * draws **nothing at all** — not even the fill beneath it — and MapLibre only warns. Without
   * these, the adapter's registration would be swallowed by its own try/catch and a layer that
   * renders blank on a real map would pass here.
   */
  images = new Map<string, { width: number; height: number; data: Uint8Array }>()

  hasImage(id: string) {
    return this.images.has(id)
  }

  addImage(id: string, image: { width: number; height: number; data: Uint8Array }) {
    this.checkLoaded()
    if (this.images.has(id)) throw new Error(`An image with the name "${id}" already exists.`)
    this.images.set(id, image)
  }

  getCanvas() {
    return { style: {} as CSSStyleDeclaration } as HTMLCanvasElement
  }

  fitBounds() {
    this.fitCalls += 1
  }

  remove() {
    this.removed = true
  }

  layerIds() {
    return this.layers.map((l) => l.id)
  }
}

export const createdMaps: Array<FakeMap> = []
export const popupsAdded: Array<string> = []
export const workerUrls: Array<string> = []

/** The `maplibre-gl` module shape, for `vi.mock`. */
export const maplibreModuleMock = () => ({
  supported: undefined,
  setWorkerUrl: (url: string) => workerUrls.push(url),
  Map: class extends FakeMap {
    constructor(opts: Record<string, unknown>) {
      super(opts)
      createdMaps.push(this)
    }
  },
  Marker: class {
    private el: HTMLElement
    constructor(o?: { element?: HTMLElement }) {
      this.el = o?.element ?? document.createElement('div')
    }
    setLngLat() {
      return this
    }
    addTo() {
      return this
    }
    remove() {
      return this
    }
    getElement() {
      return this.el
    }
  },
  Popup: class {
    private html = ''
    setLngLat() {
      return this
    }
    setHTML(h: string) {
      this.html = h
      return this
    }
    addTo() {
      popupsAdded.push(this.html)
      return this
    }
  },
  LngLatBounds: class {
    private pts: Array<unknown> = []
    extend(p: unknown) {
      this.pts.push(p)
      return this
    }
    isEmpty() {
      return this.pts.length === 0
    }
  },
})
