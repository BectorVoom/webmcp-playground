import type { Bearing, LonLat } from './geo'
import type { DepthBand, HazardClass } from './hazard'
import type { Provenance } from './provenance'

export type FacilityCategory =
  | 'evacuation_shelter'
  | 'evacuation_site'
  | 'public_facility'
  | 'hospital'

/**
 * RiskState (R3.2):
 * - 'clear': explicitly assessed and found outside flood zones
 * - 'at_risk': inside an active or scenario flood zone
 * - 'unknown': no flood data coverage to assess against
 */
export type RiskState = 'clear' | 'at_risk' | 'unknown'

export interface SafeFacility {
  readonly id: string
  readonly name: string
  readonly category: FacilityCategory
  readonly at: LonLat
  readonly metres: number
  readonly bearing: Bearing
  readonly risk: RiskState
  readonly riskDetail?: {
    readonly hazardClass: HazardClass
    readonly depth?: DepthBand
  }
  readonly provenance: Provenance
}
