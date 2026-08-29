import React from 'react'
import type { MapLayerData } from '../../ports/Map'

export interface TextEquivalentListViewProps {
  readonly layers: ReadonlyArray<MapLayerData>
}

/**
 * Text-equivalent list view of all map layer contents (R5.8, R5.9, N7).
 */
export const TextEquivalentListView: React.FC<TextEquivalentListViewProps> = ({ layers }) => {
  const visibleLayers = layers.filter((l) => l.visible)

  return (
    <div
      data-testid="map-list-view"
      role="region"
      aria-live="polite"
      aria-label="Disaster Safety Map Layers Text View"
      className="p-4 bg-slate-950 text-slate-200 overflow-y-auto h-full space-y-4 font-mono text-xs"
    >
      <div className="border-b border-slate-800 pb-2">
        <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
          Map Layers Text Representation (Accessibility / No-WebGL)
        </h3>
        <p className="text-slate-400 text-[11px]">
          Showing {visibleLayers.length} active layers containing all rendered features and facts.
        </p>
      </div>

      {visibleLayers.length === 0 ? (
        <p className="text-slate-500 italic">No active map layers populated yet.</p>
      ) : (
        visibleLayers.map((layer) => (
          <div key={layer.id} className="bg-slate-900/60 p-3 rounded border border-slate-800 space-y-2">
            <div className="flex justify-between items-center text-slate-300 font-semibold border-b border-slate-800 pb-1">
              <span>Layer: {layer.id}</span>
              <span className="text-[10px] text-slate-400">
                {layer.featureCount} features · {layer.vertexCount} vertices
              </span>
            </div>

            <div className="space-y-1 text-[11px] text-slate-300">
              {layer.geojson.features.map((feat, idx) => (
                <div key={idx} className="bg-slate-950/40 p-1.5 rounded">
                  <span className="text-blue-400 font-bold">#{idx + 1}</span>{' '}
                  <span className="text-slate-400">[{feat.geometry.type}]</span>{' '}
                  {feat.properties && (
                    <span className="text-slate-200">{JSON.stringify(feat.properties)}</span>
                  )}
                </div>
              ))}
            </div>

            {layer.attributions.length > 0 && (
              <div className="text-[10px] text-slate-500 italic">
                Attribution: {layer.attributions.join(', ')}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
