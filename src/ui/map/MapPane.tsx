import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'
import type { MapLayerData, MapLayerId, MapPort } from '../../ports/Map'
import { defaultMapPort } from '../../adapters/map/memory-map'
import { MapLibreAdapter } from '../../adapters/map/maplibre'
import { currentGeolocationPort, setDisasterMapPort } from '../../toolsets/disaster'
import { DataModeBanner } from './DataModeBanner'
import { LayerList } from './LayerList'
import { Legend } from './Legend'
import { AttributionBar } from './AttributionBar'
import { TextEquivalentListView } from './TextEquivalentListView'

export interface MapPaneProps {
  readonly mapPort?: MapPort
  readonly dataMode?: 'live' | 'fixture'
  readonly noBasemap?: boolean
}

export const MapPane: React.FC<MapPaneProps> = ({
  mapPort,
  dataMode = 'fixture',
  noBasemap = false,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<MapLibreAdapter | null>(null)
  const [layers, setLayers] = useState<ReadonlyArray<MapLayerData>>([])
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map')
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
    Effect.runPromise(port.readAllLayers()).then(setLayers).catch(() => {})
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
    Effect.runPromise(
      currentGeolocationPort.getCurrentPosition().pipe(
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
      <DataModeBanner mode={dataMode} />

      {/* Header controls */}
      <header className="bg-slate-900 px-3 py-2 border-b border-slate-800 flex items-center justify-between z-10">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-xs text-slate-200">Disaster Safety Map</span>
          {!webGLAvailable && (
            <span className="text-[10px] text-amber-400 bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800">
              No WebGL (List Mode)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="map-btn-locate"
            onClick={handleLocateMe}
            className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 cursor-pointer flex items-center gap-1"
            title="Locate user position"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
            Locate
          </button>
          <button
            type="button"
            data-testid="map-btn-focus"
            onClick={handleFocus}
            className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 cursor-pointer"
          >
            Focus
          </button>
          <button
            type="button"
            data-testid="map-btn-clear"
            onClick={handleClear}
            className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 cursor-pointer"
          >
            Clear
          </button>
          <button
            type="button"
            data-testid="map-view-toggle"
            onClick={() => setViewMode((m) => (m === 'map' ? 'list' : 'map'))}
            className="px-2 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 text-white font-medium rounded cursor-pointer"
          >
            {showListOnly ? 'Map' : 'List'}
          </button>
        </div>
      </header>

      {/* Layer Controls Bar */}
      <div className="p-2 bg-slate-900/40 border-b border-slate-800/80">
        <LayerList layers={layers} onToggle={handleToggle} />
      </div>

      {/* Main View Area */}
      <div className="flex-1 relative overflow-hidden">
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

      {/* Attribution Bar (R5.4, R8.10) */}
      <AttributionBar attributions={allAttributions} noBasemap={noBasemap} />
    </div>
  )
}
