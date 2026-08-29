import React from 'react'
import type { MapLayerData, MapLayerId } from '../../ports/Map'

export interface LayerListProps {
  readonly layers: ReadonlyArray<MapLayerData>
  readonly onToggle: (id: MapLayerId, visible: boolean) => void
}

const LAYER_LABELS: Record<MapLayerId, string> = {
  'user-position': 'User Location',
  'query-radius': 'Search Radius',
  'flood-zones': 'Flood Zones',
  facilities: 'Safe Shelters',
  routes: 'Evacuation Routes',
}

/**
 * Toggle controls for individual map layers (R5.2).
 */
export const LayerList: React.FC<LayerListProps> = ({ layers, onToggle }) => {
  const layerMap = new Map(layers.map((l) => [l.id, l]))

  const allLayerIds: ReadonlyArray<MapLayerId> = [
    'user-position',
    'query-radius',
    'flood-zones',
    'facilities',
    'routes',
  ]

  return (
    <div
      data-testid="map-layer-list"
      className="bg-slate-900/90 text-slate-200 text-xs p-2 rounded-md border border-slate-700 shadow-md flex flex-col gap-1.5 pointer-events-auto"
    >
      <div className="font-semibold text-[11px] uppercase tracking-wider text-slate-400">
        Map Layers
      </div>
      {allLayerIds.map((id) => {
        const layerData = layerMap.get(id)
        const isVisible = layerData ? layerData.visible : false
        const count = layerData ? layerData.featureCount : 0

        return (
          <label
            key={id}
            data-testid={`map-toggle-${id}`}
            className="flex items-center justify-between gap-3 text-[11px] cursor-pointer hover:text-white"
          >
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={isVisible}
                disabled={!layerData}
                onChange={(e) => onToggle(id, e.target.checked)}
                className="rounded border-slate-700 bg-slate-800 text-blue-600 focus:ring-0"
              />
              <span>{LAYER_LABELS[id]}</span>
            </div>
            {layerData && (
              <span className="text-[10px] text-slate-400 font-mono">({count})</span>
            )}
          </label>
        )
      })}
    </div>
  )
}
