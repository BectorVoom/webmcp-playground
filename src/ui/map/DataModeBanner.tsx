import React from 'react'

export interface DataModeBannerProps {
  readonly mode: 'live' | 'fixture'
}

/**
 * Persistent, unmissable banner when running on simulated fixture data (R8.4).
 */
export const DataModeBanner: React.FC<DataModeBannerProps> = ({ mode }) => {
  if (mode !== 'fixture') return null

  return (
    <div
      data-testid="map-banner-fixture"
      role="status"
      aria-label="Simulation Mode Banner"
      className="bg-amber-500 text-black font-semibold text-xs py-1 px-3 text-center uppercase tracking-wide border-b border-amber-600 shadow-sm"
    >
      ⚠️ Simulated Data Mode Active — Not for real-world emergency use
    </div>
  )
}
