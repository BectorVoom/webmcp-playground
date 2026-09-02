import { describe, expect, it } from 'vitest'
import { getRegistryForMode } from './registry'
import { StadiaRoutingProvider } from './routing/stadia'
import { FixtureRoutingProvider } from './fixture/fixture-routing'

/**
 * Routing resolves separately from the hazard data (R3.11).
 *
 * The recorded replies cover one origin. While routing followed the data mode, the default
 * fixture install drew no routes anywhere but that origin — the planner refuses to draw the
 * straight lines the fixture engine offers instead, so the map simply came up empty with nothing
 * on it to say why.
 */
describe('choosing providers for a data mode', () => {
  it('routes live over simulated hazard data, which is the default install', () => {
    const registry = getRegistryForMode('fixture', 'live')

    for (const region of ['jp', 'us', 'eu'] as const) {
      expect(registry[region].routing).toBeInstanceOf(StadiaRoutingProvider)
      // ...while everything else stays simulated and deterministic.
      expect(registry[region].places[0]!.sourceId).toContain('fixture')
      expect(registry[region].flood[0]!.sourceId).toContain('fixture')
    }
  })

  it('keeps routing on recordings when asked to, so an offline demo stays offline', () => {
    const registry = getRegistryForMode('fixture', 'fixture')
    expect(registry.jp.routing).toBeInstanceOf(FixtureRoutingProvider)
  })

  it('can hold live hazard data back to recorded routes', () => {
    const registry = getRegistryForMode('live', 'fixture')
    expect(registry.jp.routing).toBeInstanceOf(FixtureRoutingProvider)
    expect(registry.jp.places[0]!.sourceId).not.toContain('fixture')
  })

  it('follows the data mode when routing is not given one of its own', () => {
    expect(getRegistryForMode('fixture').jp.routing).toBeInstanceOf(FixtureRoutingProvider)
    expect(getRegistryForMode('live').jp.routing).toBeInstanceOf(StadiaRoutingProvider)
  })
})
