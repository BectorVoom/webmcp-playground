import React from 'react'

export interface AttributionBarProps {
  readonly attributions: ReadonlyArray<string>
  readonly noBasemap?: boolean
}

/**
 * Renders attribution for all currently visible data layers (R5.4, R8.10).
 */
export const AttributionBar: React.FC<AttributionBarProps> = ({ attributions, noBasemap }) => {
  const uniqueAttributions = Array.from(new Set(attributions)).filter(Boolean)

  return (
    <footer
      data-testid="map-bar-attribution"
      className="bg-slate-900/90 text-slate-400 text-[10px] px-3 py-1.5 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-300">Data Sources:</span>
        {uniqueAttributions.length > 0 ? (
          uniqueAttributions.map((attr, idx) => (
            <span key={idx} className="after:content-[','] last:after:content-none pr-1">
              {attr}
            </span>
          ))
        ) : (
          <span>(No active layers)</span>
        )}
      </div>

      {noBasemap && (
        <span className="text-amber-400 italic">No basemap key configured — rendering data layers only</span>
      )}
    </footer>
  )
}
