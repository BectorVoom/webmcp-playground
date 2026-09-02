import { beforeEach, describe, expect, it } from 'vitest'
import { BoundedCache, resetStaticCaches } from './static-cache'

beforeEach(() => resetStaticCaches())

describe('bounded cache', () => {
  it('returns what it was given, and misses on an unknown key', () => {
    const cache = new BoundedCache<number>({ maxEntries: 4 })
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.stats).toEqual({ size: 1, hits: 1, misses: 1 })
  })

  it('evicts the least recently used entry, not the oldest', () => {
    const cache = new BoundedCache<string>({ maxEntries: 2 })
    cache.set('a', 'A')
    cache.set('b', 'B')
    cache.get('a') // 'a' is now the most recent, so 'b' should go next
    cache.set('c', 'C')

    expect(cache.get('a')).toBe('A')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe('C')
  })

  it('never grows past its bound', () => {
    const cache = new BoundedCache<number>({ maxEntries: 3 })
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i)
    expect(cache.stats.size).toBe(3)
    expect(cache.get('k49')).toBe(49)
    expect(cache.get('k0')).toBeUndefined()
  })

  it('forgets an entry once its lifetime is up', () => {
    const cache = new BoundedCache<number>({ maxEntries: 4, ttlMs: 1000 })
    cache.set('a', 1, 0)
    expect(cache.get('a', 999)).toBe(1)
    expect(cache.get('a', 1001)).toBeUndefined()
  })

  it('keeps entries with no lifetime set', () => {
    const cache = new BoundedCache<number>({ maxEntries: 4 })
    cache.set('a', 1, 0)
    expect(cache.get('a', 1e12)).toBe(1)
  })

  it('is emptied by the shared reset, which is what keeps tests independent', () => {
    const cache = new BoundedCache<number>({ maxEntries: 4 })
    cache.set('a', 1)
    resetStaticCaches()
    expect(cache.get('a')).toBeUndefined()
    expect(cache.stats.size).toBe(0)
  })

  it('overwrites a key without growing', () => {
    const cache = new BoundedCache<number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('a', 2)
    expect(cache.get('a')).toBe(2)
    expect(cache.stats.size).toBe(1)
  })
})
