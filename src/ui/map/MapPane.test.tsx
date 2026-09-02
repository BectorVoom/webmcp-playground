import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Effect } from 'effect'
import { MapPane } from './MapPane'
import { MemoryMapAdapter } from '../../adapters/map/memory-map'
import { BrowserGeolocationAdapter } from '../../adapters/geo/browser-geolocation'
import { setDisasterGeolocationPort } from '../../toolsets/disaster'
import type { FeatureCollection } from 'geojson'

describe('MapPane Component (Phase 9, Checkpoint 9)', () => {
  it('renders persistent fixture banner when in fixture mode (R8.4)', () => {
    render(<MapPane dataMode="fixture" />)
    expect(screen.getByTestId('map-banner-fixture')).toBeInTheDocument()
    expect(screen.getByTestId('map-banner-fixture')).toHaveTextContent('Simulated Data Mode Active')
  })

  it('renders layer toggles and responds to interaction (R5.2)', async () => {
    const mapPort = new MemoryMapAdapter()
    const sampleFc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.76, 35.68] },
          properties: { name: 'Shelter A' },
        },
      ],
    }

    await Effect.runPromise(
      mapPort.setLayer('facilities', sampleFc, {
        attributions: ['国土地理院 指定緊急避難場所データ'],
      }),
    )

    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    await waitFor(() => {
      expect(screen.getByTestId('map-toggle-facilities')).toBeInTheDocument()
    })

    expect(screen.getByTestId('map-toggle-facilities')).toHaveTextContent('Safe Shelters')
    expect(screen.getByTestId('map-bar-attribution')).toHaveTextContent('国土地理院 指定緊急避難場所データ')
  })

  it('supports text-equivalent list view toggle (R5.8, R5.9, N7)', async () => {
    const mapPort = new MemoryMapAdapter()
    const sampleFc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.76, 35.68] },
          properties: { name: 'Shelter A' },
        },
      ],
    }

    await Effect.runPromise(
      mapPort.setLayer('facilities', sampleFc, {
        attributions: ['国土地理院'],
      }),
    )

    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    const toggleBtn = screen.getByTestId('map-view-toggle')
    await userEvent.click(toggleBtn)

    await waitFor(() => {
      expect(screen.getByTestId('map-list-view')).toBeInTheDocument()
    })

    expect(screen.getByTestId('map-list-view')).toHaveTextContent('Layer: facilities')
    expect(screen.getByTestId('map-list-view')).toHaveTextContent('Shelter A')
  })

  describe('Locate reports why it could not get a position (R1.2)', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      setDisasterGeolocationPort(new BrowserGeolocationAdapter())
    })

    // Only `navigator` is stubbed: replacing `window` wholesale would take the document with it.
    const stubBrowser = (permission: PermissionState) => {
      vi.stubGlobal('navigator', {
        permissions: { query: async () => ({ state: permission }) as PermissionStatus },
        geolocation: {
          getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) =>
            permission === 'denied'
              ? fail({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError)
              : ok({
                  coords: { latitude: 35.6812, longitude: 139.7671, accuracy: 20 },
                  timestamp: Date.now(),
                } as GeolocationPosition),
        },
      })
      setDisasterGeolocationPort(new BrowserGeolocationAdapter({ isSecureContext: true }))
    }

    it('surfaces a blocked permission instead of doing nothing', async () => {
      stubBrowser('denied')
      const mapPort = new MemoryMapAdapter()
      render(<MapPane mapPort={mapPort} dataMode="fixture" />)

      await userEvent.click(screen.getByTestId('map-btn-locate'))

      const alert = await screen.findByTestId('map-locate-error')
      expect(alert).toHaveTextContent(window.location.origin)
      expect(alert).toHaveTextContent(/will not prompt again/)
      expect(await Effect.runPromise(mapPort.readLayer('user-position'))).toBeUndefined()
    })

    it('pins the position and shows no error when the browser allows it', async () => {
      stubBrowser('granted')
      const mapPort = new MemoryMapAdapter()
      render(<MapPane mapPort={mapPort} dataMode="fixture" />)

      await userEvent.click(screen.getByTestId('map-btn-locate'))

      await waitFor(async () => {
        expect(await Effect.runPromise(mapPort.readLayer('user-position'))).toBeDefined()
      })
      expect(screen.queryByTestId('map-locate-error')).not.toBeInTheDocument()
    })
  })

  it('shows turn-by-turn directions for a route the tools planned (R3.7)', async () => {
    const { disasterToolSet, setDisasterDataMode, setDisasterMapPort } = await import(
      '../../toolsets/disaster'
    )
    const mapPort = new MemoryMapAdapter()
    setDisasterDataMode('fixture')
    setDisasterMapPort(mapPort)
    const geo = new BrowserGeolocationAdapter()
    // Tokyo Station: where the recorded replies were captured, so the plan is a real walk along
    // real streets and the steps below are the engine's own, not derived from a drawn line.
    geo.setPinnedPosition({
      coordinates: { latitude: 35.6812, longitude: 139.7671 },
      accuracyMetres: 35,
      source: 'pinned',
      resolvedAt: Date.now(),
    })
    setDisasterGeolocationPort(geo)

    const routes = disasterToolSet.tools.find((t) => t.name === 'disaster.evacuation_routes')!
    await Effect.runPromise(
      routes.execute({ destination: 'Tokyo International Forum' } as never, {} as never),
    )

    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    // The panel reads the map layer, so this is the real plan, not a fixture of the UI's own.
    const panel = await screen.findByTestId('route-directions')
    expect(within(panel).getByTestId('route-destination')).toHaveTextContent(
      'Tokyo International Forum',
    )

    const steps = within(await screen.findByTestId('route-steps')).getAllByRole('listitem')
    expect(steps.length).toBeGreaterThan(2)
    // Named streets are the mark of guidance taken off a road network rather than off a bearing.
    expect(panel.textContent).toMatch(/中央通路/)
    expect(
      within(panel)
        .getAllByRole('img')
        .map((i) => i.getAttribute('aria-label')),
    ).toContain('Arrive')
  })

  it('offers the ways round it found and highlights only the chosen one (R3.7, R3.9)', async () => {
    const { disasterToolSet, setDisasterDataMode, setDisasterMapPort } = await import(
      '../../toolsets/disaster'
    )
    const mapPort = new MemoryMapAdapter()
    setDisasterDataMode('fixture')
    setDisasterMapPort(mapPort)
    const geo = new BrowserGeolocationAdapter()
    geo.setPinnedPosition({
      coordinates: { latitude: 35.6812, longitude: 139.7671 },
      accuracyMetres: 35,
      source: 'pinned',
      resolvedAt: Date.now(),
    })
    setDisasterGeolocationPort(geo)

    const routes = disasterToolSet.tools.find((t) => t.name === 'disaster.evacuation_routes')!
    await Effect.runPromise(
      routes.execute({ destination: 'Tokyo International Forum' } as never, {} as never),
    )

    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    const options = await screen.findByTestId('route-options')
    const buttons = within(options).getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(1)

    // One route is being followed at a time: the safest, until the reader picks another.
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    expect(screen.getByTestId('route-option-1')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByTestId('route-option-2'))
    expect(screen.getByTestId('route-option-2')).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(screen.getByTestId('route-options'))
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1)
  })

  it('opens on the safest route and highlights only the one chosen (R3.7)', async () => {
    const twoRoutes: FeatureCollection = {
      type: 'FeatureCollection',
      features: [1, 2].map((rank) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[139.46, 35.56], [139.47, 35.57]] },
        properties: {
          rank,
          destination: `Shelter ${rank}`,
          destinationRisk: 'clear',
          metres: rank * 500,
          seconds: rank * 400,
          costing: 'pedestrian',
          exclusions: 'applied',
          crossings: 0,
          crossingsAssessed: true,
          simulated: true,
          steps: [{ instruction: 'Head N.', metres: 100, seconds: 80, maneuver: 'depart' }],
        },
      })),
    }
    const mapPort = new MemoryMapAdapter()
    await Effect.runPromise(mapPort.setLayer('routes', twoRoutes))

    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    // Rank 1 is the safest the planner found, so it is what the panel opens on.
    await waitFor(() => {
      expect(screen.getByTestId('route-option-1')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(screen.getByTestId('route-destination')).toHaveTextContent('Shelter 1')

    await userEvent.click(screen.getByTestId('route-option-2'))
    expect(screen.getByTestId('route-option-2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('route-option-1')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('route-destination')).toHaveTextContent('Shelter 2')
  })

  it('shows no directions panel until a route exists', async () => {
    const mapPort = new MemoryMapAdapter()
    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    await waitFor(() => {
      expect(screen.getByTestId('map-layer-list')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('route-directions')).toBeNull()
  })

  it('triggers focus and clear controls (R5.3)', async () => {
    const mapPort = new MemoryMapAdapter()
    await Effect.runPromise(
      mapPort.setLayer('facilities', {
        type: 'FeatureCollection',
        features: [],
      }),
    )

    render(<MapPane mapPort={mapPort} dataMode="fixture" />)

    await userEvent.click(screen.getByTestId('map-btn-focus'))
    expect(mapPort.getFocus()).toBe('all')

    await userEvent.click(screen.getByTestId('map-btn-clear'))
    const layers = await Effect.runPromise(mapPort.readAllLayers())
    expect(layers.length).toBe(0)
  })
})
