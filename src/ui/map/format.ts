/** Distance and duration wording shared by the map surfaces. */

export const formatDistance = (metres: number): string =>
  metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`

export const formatDuration = (seconds: number): string => {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
