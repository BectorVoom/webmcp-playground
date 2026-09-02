import { describe, expect, it, vi, afterEach } from 'vitest'
import { Effect } from 'effect'
import { BrowserGeolocationAdapter } from './browser-geolocation'
import { disasterToolSet, setDisasterGeolocationPort } from '../../toolsets/disaster'
import { publishSchema } from '../../domain/schema'

/**
 * The failure a user reports as "it can't get my location" is almost never the geolocation call
 * itself — it is the browser refusing before the call, with nothing in the app able to say so.
 * A denial the browser has stored never prompts again, and the setting is origin-scoped, so
 * allowing it on one host or port grants nothing to another. These pin the diagnosis the app owes
 * the user and the model in that state.
 */

const PERMISSION_DENIED = 1
const POSITION_UNAVAILABLE = 2

const installNavigator = (options: {
  permission?: PermissionState | 'throws' | 'absent'
  position?: { latitude: number; longitude: number }
  errorCode?: number
}) => {
  const calls: Array<PositionOptions | undefined> = []
  const permissions =
    options.permission === 'absent'
      ? undefined
      : {
          query: vi.fn(async () => {
            if (options.permission === 'throws') throw new TypeError("'geolocation' is not a valid name")
            return { state: options.permission ?? 'prompt' } as PermissionStatus
          }),
        }

  vi.stubGlobal('navigator', {
    permissions,
    geolocation: {
      getCurrentPosition: (
        ok: PositionCallback,
        fail: PositionErrorCallback,
        opts?: PositionOptions,
      ) => {
        calls.push(opts)
        if (options.errorCode !== undefined) {
          fail({ code: options.errorCode, message: 'User denied Geolocation' } as GeolocationPositionError)
          return
        }
        ok({
          coords: { latitude: options.position!.latitude, longitude: options.position!.longitude, accuracy: 22 },
          timestamp: Date.now(),
        } as GeolocationPosition)
      },
    },
  })

  vi.stubGlobal('window', { isSecureContext: true, location: { origin: 'http://127.0.0.1:5173' } })
  return { calls, permissions }
}

describe('geolocation when the browser is already refusing (R1.2, R1.8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('explains a standing block rather than repeating the browser\'s bare refusal', async () => {
    const { calls } = installNavigator({ permission: 'denied', errorCode: PERMISSION_DENIED })
    const adapter = new BrowserGeolocationAdapter()

    const error = await Effect.runPromise(Effect.flip(adapter.getCurrentPosition()))

    expect(error._tag).toBe('GeolocationDenied')
    // A prompt that will never appear is the whole problem: say so, and name the origin, because
    // the setting does not carry across host or port.
    expect(error.message).toContain('http://127.0.0.1:5173')
    expect(error.message).toMatch(/will not prompt again/)
    expect(error.message).toMatch(/per-origin/)
    // The reading only enriches the error; a browser that reports it wrongly must not cost us a
    // position we would otherwise have got.
    expect(calls, 'the call is still made regardless of the reported permission').toHaveLength(1)
  })

  it('still returns a position when the API succeeds despite a denied reading', async () => {
    installNavigator({ permission: 'denied', position: { latitude: 35.6812, longitude: 139.7671 } })
    const adapter = new BrowserGeolocationAdapter()

    const loc = await Effect.runPromise(adapter.getCurrentPosition())
    expect(loc.coordinates.latitude).toBeCloseTo(35.6812)
  })

  it('still asks when the permission is merely unresolved', async () => {
    const { calls } = installNavigator({ permission: 'prompt', position: { latitude: 35.6812, longitude: 139.7671 } })
    const adapter = new BrowserGeolocationAdapter()

    const loc = await Effect.runPromise(adapter.getCurrentPosition())

    expect(loc.coordinates).toEqual({ latitude: 35.6812, longitude: 139.7671 })
    expect(loc.source).toBe('geolocation')
    expect(calls).toHaveLength(1)
  })

  it('asks when the permission is granted', async () => {
    const { calls } = installNavigator({ permission: 'granted', position: { latitude: 51.5074, longitude: -0.1278 } })
    const adapter = new BrowserGeolocationAdapter()

    await Effect.runPromise(adapter.getCurrentPosition())
    expect(calls).toHaveLength(1)
  })

  it('falls through to the API where the Permissions API is missing or rejects the name', async () => {
    for (const permission of ['absent', 'throws'] as const) {
      vi.unstubAllGlobals()
      const { calls } = installNavigator({ permission, position: { latitude: 40.7128, longitude: -74.006 } })
      const adapter = new BrowserGeolocationAdapter()

      const loc = await Effect.runPromise(adapter.getCurrentPosition())
      expect(loc.coordinates.latitude, permission).toBeCloseTo(40.7128)
      expect(calls, permission).toHaveLength(1)
    }
  })
})

describe('what the model is told when location fails', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())
  })

  const runTool = async (name: string, input: unknown = {}) => {
    const tool = disasterToolSet.tools.find((t) => t.name === name)!
    return Effect.runPromise(Effect.flip(tool.execute(input as never, {} as never)))
  }

  it('explains a standing block and what to do, rather than echoing the browser', async () => {
    installNavigator({ permission: 'denied', errorCode: PERMISSION_DENIED })
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())

    const error = await runTool('disaster.locate')

    expect(error._tag).toBe('ToolExecutionError')
    expect(error.message).toContain('http://127.0.0.1:5173')
    expect(error.message).toMatch(/Clear this site's location setting/)
    // The remedy the model can actually act on without the user touching anything.
    expect(error.message).toMatch(/pass explicit coordinates/i)
  })

  it('names the tool that actually failed, not always disaster.locate', async () => {
    installNavigator({ permission: 'prompt', errorCode: POSITION_UNAVAILABLE })
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())

    expect((await runTool('disaster.find_shelters')).tool).toBe('disaster.find_shelters')
    expect((await runTool('disaster.evacuation_routes')).tool).toBe('disaster.evacuation_routes')
    expect((await runTool('disaster.locate')).tool).toBe('disaster.locate')
  })

  it('carries the browser message through for a fresh refusal', async () => {
    installNavigator({ permission: 'prompt', errorCode: PERMISSION_DENIED })
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())

    const error = await runTool('disaster.locate')
    expect(error.message).toContain('denied')
  })

  it('leaves location alone when the caller supplied coordinates', async () => {
    installNavigator({ permission: 'denied', errorCode: PERMISSION_DENIED })
    setDisasterGeolocationPort(new BrowserGeolocationAdapter())

    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.find_shelters')!
    const result = await Effect.runPromise(
      tool.execute({ latitude: 35.6812, longitude: 139.7671 } as never, {} as never),
    )
    expect(result.content[0]!.text).toContain('SAFE FACILITIES')
  })
})

describe('no-argument tools publish a usable parameters schema', () => {
  it('publishes an object schema, not JSON Schema "any object or array"', () => {
    for (const name of ['disaster.locate', 'disaster.clear_map']) {
      const tool = disasterToolSet.tools.find((t) => t.name === name)!
      const schema = publishSchema(tool)

      // This lands verbatim in OpenAI-compatible `function.parameters`, where an `anyOf` of object
      // and array leaves a grammar-constrained decoder free to emit `[]` for a tool taking nothing.
      expect(schema, name).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      })
      expect(schema.anyOf, name).toBeUndefined()
      expect(schema.$id, name).toBeUndefined()
    }
  })

  it('leaves a tool that does take arguments untouched', () => {
    const tool = disasterToolSet.tools.find((t) => t.name === 'disaster.evacuation_routes')!
    const schema = publishSchema(tool) as { type: string; properties: Record<string, unknown> }

    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toContain('mode')
  })
})
