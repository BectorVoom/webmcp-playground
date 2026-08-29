import type { Provenance } from './provenance'

export type AlertSeverity = 'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown'
export type AlertUrgency = 'immediate' | 'expected' | 'future' | 'past' | 'unknown'
export type AlertCertainty = 'observed' | 'likely' | 'possible' | 'unlikely' | 'unknown'

/**
 * CAP-aligned OfficialAlert (R4.2).
 * Verbatim text fields only with a language tag; deliberately no summary or machine translation (R4.6, ADR-5).
 */
export interface OfficialAlert {
  readonly id: string
  readonly event: string
  readonly severity: AlertSeverity
  readonly urgency: AlertUrgency
  readonly certainty: AlertCertainty
  readonly headline: string
  readonly description: string
  readonly instruction: string | null
  readonly onset: number | null // epoch ms
  readonly effective: number // epoch ms
  readonly expires: number | null // epoch ms
  readonly sender: string
  readonly areaDescription: string
  readonly language: string // e.g. 'en', 'ja'
  readonly officialTranslation?: {
    readonly language: string
    readonly headline: string
    readonly description: string
    readonly instruction: string | null
  }
  readonly provenance: Provenance
}
