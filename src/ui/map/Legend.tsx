import React from 'react'
import { FLOOD_FILL_OPACITY, HAZARD_PALETTE, hatchCss } from '../../lib/hazard-palette'

/**
 * Visual legend encoding hazard classes by both pattern and colour (R5.7).
 *
 * Swatches are painted from `HAZARD_PALETTE` — the same table the map layer builds its paint
 * expressions from — rather than from Tailwind classes chosen to look about right. The two lists
 * had drifted on every band, so the legend described a map that did not exist.
 */
export const Legend: React.FC = () => {
  return (
    <div
      data-testid="map-legend"
      className="bg-slate-900/90 text-slate-200 text-ui p-2.5 rounded-md border border-slate-700 shadow-md flex flex-col gap-2 pointer-events-auto"
    >
      <div className="font-semibold text-ui uppercase tracking-wider text-slate-400">
        Flood Hazard Depth
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-ui">
        {HAZARD_PALETTE.map((entry) => (
          <div
            key={entry.hazardClass}
            data-testid={`legend-hazard-${entry.hazardClass}`}
            className="flex items-center gap-1.5"
            title={entry.note}
          >
            <span
              className="w-3.5 h-3.5 rounded-sm shrink-0 border"
              data-hatch={entry.hatch}
              // The fill is drawn over the basemap at this opacity, so a fully opaque swatch is a
              // brighter colour than anything actually on the map. The hatch on top is what makes
              // the class legible without colour (R5.7), and it is the same texture the map draws.
              style={{
                backgroundColor: entry.fill,
                backgroundImage: hatchCss(entry.hatch),
                backgroundSize: entry.hatch === 'dots' ? '4px 4px' : undefined,
                opacity: FLOOD_FILL_OPACITY + (1 - FLOOD_FILL_OPACITY) / 2,
                borderColor: entry.line,
              }}
            />
            <span>
              {entry.label} ({entry.depthLabel})
            </span>
          </div>
        ))}
      </div>

      {/*
        A modelled extent and an authority's hazard map use the same depth colours, so the only
        thing telling them apart on the canvas is the dashed edge. Unexplained, that is a
        distinction the reader cannot make — and the two carry very different weight.
      */}
      <div
        data-testid="legend-modelled-inundation"
        className="flex items-start gap-1.5 text-ui border-t border-slate-800 pt-1.5 mt-1"
      >
        <span className="w-3.5 h-3.5 rounded-sm shrink-0 border-2 border-dashed border-slate-300 mt-px" />
        <span>
          Dashed edge: <strong>modelled estimate</strong>, not an official hazard map. Over-predicts
          area.
        </span>
      </div>

      <div className="font-semibold text-ui uppercase tracking-wider text-slate-400 mt-1 border-t border-slate-800 pt-1.5">
        Shelters &amp; Routes
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-ui">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-emerald-600 border border-white" />
          <span>Clear Shelter</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-600 border border-white" />
          <span>At-Risk Shelter</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-amber-500 border border-white" />
          <span>Unknown Risk</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-blue-500" />
          <span>Route (Avoided)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 border-t-2 border-dashed border-amber-400" />
          <span>Route (Unavoided)</span>
        </div>
        {/* Alternatives are drawn thin and grey, so the one being followed reads as the answer. */}
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-px bg-slate-400" />
          <span>Other candidate</span>
        </div>
        {/* A geocoded place is somewhere the user asked about — never somewhere to shelter. */}
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-pink-600 border border-white" />
          <span>Searched Place</span>
        </div>
      </div>
    </div>
  )
}
