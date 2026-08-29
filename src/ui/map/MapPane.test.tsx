import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Effect } from 'effect'
import { MapPane } from './MapPane'
import { MemoryMapAdapter } from '../../adapters/map/memory-map'
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
