import type { AlertCertainty, AlertSeverity, AlertUrgency } from '../../domain/alerts'

/**
 * The CAP 1.2 vocabulary, shared by every source that speaks it.
 *
 * NWS and MeteoAlarm both publish CAP, so the same five severities and the same parsing rules
 * apply to both. An unrecognised value becomes 'unknown' rather than being guessed at: a warning
 * shown one step milder than it was issued is worse than one shown as unclassified.
 */
const SEVERITIES: Readonly<Record<string, AlertSeverity>> = {
  extreme: 'extreme',
  severe: 'severe',
  moderate: 'moderate',
  minor: 'minor',
}
const URGENCIES: Readonly<Record<string, AlertUrgency>> = {
  immediate: 'immediate',
  expected: 'expected',
  future: 'future',
  past: 'past',
}
const CERTAINTIES: Readonly<Record<string, AlertCertainty>> = {
  observed: 'observed',
  likely: 'likely',
  possible: 'possible',
  unlikely: 'unlikely',
}

export const capSeverity = (raw: string | null | undefined): AlertSeverity =>
  SEVERITIES[(raw ?? '').trim().toLowerCase()] ?? 'unknown'

export const capUrgency = (raw: string | null | undefined): AlertUrgency =>
  URGENCIES[(raw ?? '').trim().toLowerCase()] ?? 'unknown'

export const capCertainty = (raw: string | null | undefined): AlertCertainty =>
  CERTAINTIES[(raw ?? '').trim().toLowerCase()] ?? 'unknown'

export const capEpoch = (raw: string | null | undefined): number | null => {
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Worst first. Used to make sure a result cap can never drop the most severe alert. */
export const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = {
  extreme: 0,
  severe: 1,
  moderate: 2,
  minor: 3,
  unknown: 4,
}

/**
 * Whether a CAP message describes something real and current.
 *
 * `status` separates live warnings from drills and system tests, which arrive down the same pipe;
 * `messageType` of Cancel is the record of a warning ending, not a warning.
 */
export const isActualAlert = (
  status: string | null | undefined,
  messageType: string | null | undefined,
): boolean => {
  if (status && status.trim().toLowerCase() !== 'actual') return false
  if (messageType && messageType.trim().toLowerCase() === 'cancel') return false
  return true
}
