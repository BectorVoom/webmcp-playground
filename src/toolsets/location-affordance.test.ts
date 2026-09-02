import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { disasterToolSet, setDisasterGeolocationPort } from './disaster'
import { publishSchema } from '../domain/schema'
import { BrowserGeolocationAdapter } from '../adapters/geo/browser-geolocation'
import type { AnyToolDefinition } from '../domain/tool'

/**
 * Whether the model can get the user's location is settled by the text it is shown, not by the
 * geolocation code beneath it.
 *
 * Given bare `latitude` / `longitude` fields, gemma4:e2b read them as information it had to
 * obtain and replied "Please provide your current location (latitude and longitude)" — or, in
 * Japanese, "現在地を教えていただけますか？緯度と経度が必要です。" — instead of calling the tool at
 * all. The device position was never consulted, and the user was asked to look up their own
 * coordinates. Naming the fallback in the published text fixed it across every prompt tried.
 *
 * These assert that contract on the exact strings the model receives, so the affordance cannot be
 * dropped by an edit that still typechecks.
 */

interface PublishedProperties {
  readonly type?: string
  readonly required?: ReadonlyArray<string>
  readonly properties?: Record<string, { description?: string }>
}

const published = (tool: AnyToolDefinition) => publishSchema(tool) as PublishedProperties

/** A tool falls back to the device position exactly when both coordinates are optional. */
const fallsBackToDeviceLocation = (tool: AnyToolDefinition): boolean => {
  const schema = published(tool)
  const props = schema.properties ?? {}
  const required = schema.required ?? []
  return (
    'latitude' in props &&
    'longitude' in props &&
    !required.includes('latitude') &&
    !required.includes('longitude')
  )
}

const locationTools = disasterToolSet.tools.filter(fallsBackToDeviceLocation)

/** Says, in some wording, that leaving the coordinates out uses the device's position. */
const documentsTheFallback = (text: string | undefined): boolean =>
  text !== undefined && /omit/i.test(text) && /current location/i.test(text)

describe('tools that fall back to the device position advertise it (R1.1, R3.5)', () => {
  it('covers every tool that takes optional coordinates', () => {
    expect(locationTools.map((t) => t.name)).toEqual([
      'disaster.flood_forecast',
      'disaster.inundation_model',
      'disaster.find_shelters',
      'disaster.evacuation_routes',
      'disaster.official_alerts',
    ])
  })

  it.each(locationTools.map((t) => [t.name, t] as const))(
    '%s tells the model that omitting the coordinates uses the current location',
    (_name, tool) => {
      expect(documentsTheFallback(tool.description)).toBe(true)
      // Guessing is the other failure mode: a model that invents plausible coordinates silently
      // answers about the wrong place, which is worse than admitting it cannot tell.
      expect(tool.description).toMatch(/never guess/i)
    },
  )

  it.each(locationTools.map((t) => [t.name, t] as const))(
    '%s documents the fallback on the coordinate fields themselves',
    (name, tool) => {
      const props = published(tool).properties ?? {}
      for (const field of ['latitude', 'longitude']) {
        const description = props[field]?.description
        expect(description, `${name}.${field} has no description`).toBeDefined()
        expect(documentsTheFallback(description), `${name}.${field}: "${description}"`).toBe(true)
      }
    },
  )

  it('still accepts explicit coordinates when the user names a place', async () => {
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.find_shelters')!

    const result = await Effect.runPromise(
      tool.execute({ latitude: 35.6812, longitude: 139.7671 } as never, {} as never),
    )
    expect(result.content[0]!.text).toContain('SAFE FACILITIES')
  })
})

describe('disaster.locate is reachable without the model knowing anything', () => {
  const locate = disasterToolSet.tools.find((t) => t.name === 'disaster.locate')!

  it('requires no arguments at all', () => {
    const schema = published(locate)
    expect(schema.type).toBe('object')
    expect(schema.required ?? []).toEqual([])
    expect(Object.keys(schema.properties ?? {})).toEqual([])
  })

  it('tells the model to call it rather than ask the user for coordinates', () => {
    expect(locate.description).toMatch(/takes no arguments/i)
    expect(locate.description).toMatch(/instead of asking them for coordinates/i)
  })
})

describe('named alert areas are a one-tool operation', () => {
  const alerts = disasterToolSet.tools.find((t) => t.name === 'disaster.official_alerts')!

  it('publishes placeName before the optional coordinate fallback', () => {
    const schema = published(alerts)
    expect(Object.keys(schema.properties ?? {})[0]).toBe('placeName')
    expect(schema.properties?.placeName?.description).toMatch(/whenever the user supplies a place name/i)
    expect(schema.properties?.latitude?.description).toMatch(/omit it when placeName is set/i)
    expect(schema.properties?.longitude?.description).toMatch(/omit it when placeName is set/i)
  })

  it('tells the model to call directly instead of asking for coordinates', () => {
    expect(alerts.description).toMatch(/pass it as placeName and call this tool immediately/i)
    expect(alerts.description).toMatch(/do not ask for latitude or longitude/i)
    expect(alerts.description).toMatch(/do not call disaster\.geocode first/i)
  })
})
