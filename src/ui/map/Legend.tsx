import React from 'react'

/**
 * Visual legend encoding hazard classes by both pattern and colour (R5.7).
 */
export const Legend: React.FC = () => {
  return (
    <div
      data-testid="map-legend"
      className="bg-slate-900/90 text-slate-200 text-xs p-2.5 rounded-md border border-slate-700 shadow-md flex flex-col gap-2 pointer-events-auto"
    >
      <div className="font-semibold text-[11px] uppercase tracking-wider text-slate-400">
        Flood Hazard Depth
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm bg-purple-700 border border-purple-400" />
          <span>Extreme (5.0m+)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm bg-rose-500 border border-rose-300" />
          <span>High (3.0–5.0m)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm bg-amber-400 border border-amber-200" />
          <span>Moderate (0.5–3.0m)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm bg-yellow-200 border border-yellow-100" />
          <span>Low (&lt;0.5m)</span>
        </div>
      </div>

      <div className="font-semibold text-[11px] uppercase tracking-wider text-slate-400 mt-1 border-t border-slate-800 pt-1.5">
        Shelters &amp; Routes
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-emerald-500" />
          <span>Clear Shelter</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rotate-45 bg-rose-500" />
          <span>At-Risk Shelter</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-blue-500" />
          <span>Route (Avoided)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 border-t-2 border-dashed border-amber-400" />
          <span>Route (Unavoided)</span>
        </div>
      </div>
    </div>
  )
}
