import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'
import type { MapLayerData, MapLayerId, MapPort } from '../../ports/Map'
import { defaultMapPort } from '../../adapters/map/memory-map'
import { MapLibreAdapter } from '../../adapters/map/maplibre'
import { describeGeoError, remedyForGeoError } from '../../domain/geo-errors'
import { currentDataMode, currentGeolocationPort, setDisasterMapPort } from '../../toolsets/disaster'
import { DataModeBanner } from './DataModeBanner'
import { LayerList } from './LayerList'
import { Legend } from './Legend'
import { RouteDirections } from './RouteDirections'
import { AttributionBar } from './AttributionBar'
import { TextEquivalentListView } from './TextEquivalentListView'

export interface MapPaneProps {
  readonly mapPort?: MapPort
  readonly dataMode?: 'live' | 'fixture'
  readonly noBasemap?: boolean
}

export const MapPane: React.FC<MapPaneProps> = ({ mapPort, dataMode, noBasemap = false }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<MapLibreAdapter | null>(null)
  const [layers, setLayers] = useState<ReadonlyArray<MapLayerData>>([])
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map')
  const [locateError, setLocateError] = useState<string | null>(null)
  // Without an explicit prop, follow the mode the toolset settled on after asking the server —
  // the banner has to say which of the two the reader is actually looking at.
  const [detectedMode, setDetectedMode] = useState<'live' | 'fixture'>(currentDataMode)
  const effectiveMode = dataMode ?? detectedMode
  const [webGLAvailable] = useState<boolean>(() => {
    try {
      const canvas = document.createElement('canvas')
      return Boolean(window.WebGLRenderingContext && canvas.getContext('webgl'))
    } catch {
      return false
    }
  })

  // Initialize MapLibreAdapter on mount if in browser with WebGL and no explicit mapPort prop
  useEffect(() => {
    if (mapPort) {
      setDisasterMapPort(mapPort)
      return
    }

    if (webGLAvailable && mapContainerRef.current) {
      const adapter = new MapLibreAdapter({
        container: mapContainerRef.current,
        noBasemap,
      })
      adapterRef.current = adapter
      setDisasterMapPort(adapter)

      return () => {
        adapter.destroy()
        adapterRef.current = null
      }
    }
  }, [webGLAvailable, mapPort, noBasemap])

  const getActivePort = useCallback((): MapPort => {
    return mapPort ?? adapterRef.current ?? defaultMapPort
  }, [mapPort])

  const refreshLayers = useCallback(() => {
    const port = getActivePort()
    Effect.runPromise(port.readAllLayers())
      .then((next) => {
        setLayers(next)
        setDetectedMode(currentDataMode)
      })
      .catch(() => {})
  }, [getActivePort])

  useEffect(() => {
    refreshLayers()
    const timer = setInterval(refreshLayers, 500)
    return () => clearInterval(timer)
  }, [refreshLayers])

  const handleToggle = (id: MapLayerId, visible: boolean) => {
    const port = getActivePort()
    Effect.runPromise(port.toggleLayer(id, visible)).then(refreshLayers).catch(() => {})
  }

  const handleFocus = () => {
    const port = getActivePort()
    Effect.runPromise(port.focus('all')).catch(() => {})
  }

  const handleClear = () => {
    const port = getActivePort()
    Effect.runPromise(port.clear()).then(refreshLayers).catch(() => {})
  }

  const handleLocateMe = useCallback(() => {
    setLocateError(null)
    Effect.runPromise(
      currentGeolocationPort.getCurrentPosition().pipe(
        Effect.mapError((err) => {
          // Swallowing this left the only affordance for granting location silently inert: the
          // button appeared to do nothing whether the browser was blocking, prompting or offline.
          setLocateError(`${describeGeoError(err)} ${remedyForGeoError(err)}`)
          return err
        }),
        Effect.flatMap((loc) => {
          const userGeojson: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [loc.coordinates.longitude, loc.coordinates.latitude],
                },
                properties: { accuracy: loc.accuracyMetres, source: loc.source },
              },
            ],
          }
          const port = getActivePort()
          return port.setLayer('user-position', userGeojson)
        }),
      ),
    )
      .then(refreshLayers)
      .catch(() => {})
  }, [getActivePort, refreshLayers])

  // A fresh plan re-opens on its safest route (rank 1), in both the map and the directions list.
  const routesUpdatedAt = layers.find((l) => l.id === 'routes')?.updatedAt
  useEffect(() => {
    if (routesUpdatedAt !== undefined) adapterRef.current?.highlightRoute(1)
  }, [routesUpdatedAt])

  const allAttributions = layers
    .filter((l) => l.visible)
    .flatMap((l) => l.attributions)

  const showListOnly = !webGLAvailable || viewMode === 'list'

  return (
    <div
      data-testid="map-pane"
      className="flex flex-col h-full bg-slate-950 border-l border-slate-800 relative select-none"
    >
      {/* 1. Persistent Fixture Mode Banner (R8.4) */}
      <DataModeBanner mode={effectiveMode} />

      {/* Header controls */}
      <header className="bg-slate-900 px-3 py-2 border-b border-slate-800 flex flex-wrap items-center justify-between gap-y-2 z-10">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-body text-slate-200 whitespace-nowrap">Disaster Safety Map</span>
          {!webGLAvailable && (
            <span className="text-meta whitespace-nowrap text-amber-400 bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800">
              No WebGL (List Mode)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="map-btn-locate"
            onClick={handleLocateMe}
            className="px-2 py-1 text-ui bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 cursor-pointer flex items-center gap-1"
            title="Locate user position"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
            Locate
          </button>
          <button
            type="button"
            data-testid="map-btn-focus"
            onClick={handleFocus}
            className="px-2 py-1 text-ui bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 cursor-pointer"
          >
            Focus
          </button>
          <button
            type="button"
            data-testid="map-btn-clear"
            onClick={handleClear}
            className="px-2 py-1 text-ui bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 cursor-pointer"
          >
            Clear
          </button>
          <button
            type="button"
            data-testid="map-view-toggle"
            onClick={() => setViewMode((m) => (m === 'map' ? 'list' : 'map'))}
            className="px-2 py-1 text-ui bg-blue-600 hover:bg-blue-500 text-white font-medium rounded cursor-pointer"
          >
            {showListOnly ? 'Map' : 'List'}
          </button>
        </div>
      </header>

      {locateError && (
        <div
          data-testid="map-locate-error"
          role="alert"
          className="px-3 py-2 text-ui bg-amber-950/70 text-amber-200 border-b border-amber-800"
        >
          {locateError}
        </div>
      )}

      {/* Layer Controls Bar */}
      <div className="p-2 bg-slate-900/40 border-b border-slate-800/80">
        <LayerList layers={layers} onToggle={handleToggle} />
      </div>

      {/* Main View Area. The minimum keeps a long directions list from squeezing the map away. */}
      <div className="flex-1 relative overflow-hidden min-h-[220px]">
        {showListOnly ? (
          <TextEquivalentListView layers={layers} />
        ) : (
          <div className="w-full h-full relative bg-slate-900 flex items-center justify-center">
            {/* Map Container Canvas */}
            <div
              ref={mapContainerRef}
              id="maplibre-container"
              className="w-full h-full absolute inset-0"
            />

            {/* Overlaid Legend */}
            <div className="absolute top-3 right-3 z-10 pointer-events-none">
              <Legend />
            </div>
          </div>
        )}
      </div>

      {/* Turn-by-turn guidance for the planned routes (R3.7) */}
      <RouteDirections
        layers={layers}
        onFocusStep={(at) => adapterRef.current?.flyTo(at)}
        onSelectRoute={(rank) => adapterRef.current?.highlightRoute(rank)}
      />

      {/* Attribution Bar (R5.4, R8.10) */}
      <AttributionBar attributions={allAttributions} noBasemap={noBasemap} />
    </div>
  )
}
