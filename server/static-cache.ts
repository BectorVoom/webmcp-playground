/**
 * In-process caches for the inputs that depend on *where* a query is, not what
 * is being asked about it.
 *
 * A flood model run pulls static things that do not change between storms: DEM
 * tiles, rainfall climatology, mapped embankments, standing water, and built
 * infrastructure. Re-asking a
 * question about the same place with a different rainfall was costing ~20 s of
 * refetching all of it. The response cache upstream of this only helps a
 * byte-identical repeat, which is the one case a caller is least likely to make.
 *
 * Kept deliberately small and boring: a bounded map with an optional lifetime,
 * evicting whatever was used longest ago.
 */

export interface CacheOptions {
  readonly maxEntries: number
  /** Lifetime of an entry. Omit for data that does not go stale. */
  readonly ttlMs?: number
}

interface Entry<V> {
  readonly value: V
  readonly storedAt: number
}

const registry: Array<{ clear: () => void }> = []

export class BoundedCache<V> {
  private readonly entries = new Map<string, Entry<V>>()
  private readonly maxEntries: number
  private readonly ttlMs: number | undefined
  private hits = 0
  private misses = 0

  constructor(options: CacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries)
    this.ttlMs = options.ttlMs
    registry.push({ clear: () => this.clear() })
  }

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.misses++
      return undefined
    }
    if (this.ttlMs !== undefined && now - entry.storedAt > this.ttlMs) {
      this.entries.delete(key)
      this.misses++
      return undefined
    }
    // Re-insert so insertion order doubles as recency order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return entry.value
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, { value, storedAt: now })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.entries.clear()
    this.hits = 0
    this.misses = 0
  }

  get stats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hits, misses: this.misses }
  }
}

/**
 * Empties every cache built here.
 *
 * Production never needs this — the point is to keep the data. Tests do: they
 * ask about one location with several different stubbed upstreams, and a cache
 * keyed on location alone would hand the second test the first one's answer.
 */
export const resetStaticCaches = (): void => {
  for (const cache of registry) cache.clear()
}
