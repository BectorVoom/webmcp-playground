import { describe, expect, it } from 'vitest'
import { JMA_OFFICES, resolveJmaOffice } from './jma-areas'

/** Station or city hall coordinates, and the JMA office that publishes their warnings. */
const CITIES: ReadonlyArray<readonly [string, number, number, string]> = [
  // The case that started this: Fukui must not resolve to Ishikawa, whose box overlaps it.
  ['福井駅', 136.2233, 36.0619, '180000'],
  ['東京駅', 139.7671, 35.6812, '130000'],
  ['父島（小笠原）', 142.1917, 27.0944, '130000'],
  ['横浜', 139.6222, 35.4657, '140000'],
  ['大阪駅', 135.5023, 34.6937, '270000'],
  ['京都駅', 135.7681, 35.0116, '260000'],
  ['名古屋駅', 136.9066, 35.1815, '230000'],
  ['仙台駅', 140.8694, 38.2682, '040000'],
  ['新潟駅', 139.0364, 37.9161, '150000'],
  ['金沢駅', 136.6562, 36.5613, '170000'],
  ['富山駅', 137.2137, 36.7015, '160000'],
  ['広島駅', 132.4553, 34.3853, '340000'],
  ['高知駅', 133.5311, 33.5597, '390000'],
  ['松山駅', 132.7657, 33.8392, '380000'],
  ['福岡（博多）', 130.4017, 33.5904, '400000'],
  ['長崎駅', 129.8779, 32.7503, '420000'],
  ['鹿児島中央', 130.5571, 31.5966, '460100'],
  ['名瀬（奄美）', 129.4936, 28.3775, '460040'],
  // Hokkaido is eight offices, so a single "010000" would 404 for every one of these.
  ['札幌駅', 141.3545, 43.0618, '016000'],
  ['函館駅', 140.7288, 41.7688, '017000'],
  ['旭川駅', 142.365, 43.7708, '012000'],
  ['稚内駅', 141.673, 45.4156, '011000'],
  ['網走駅', 144.2735, 44.0206, '013000'],
  ['帯広駅', 143.1965, 42.9239, '014030'],
  ['釧路駅', 144.382, 42.9849, '014100'],
  ['苫小牧駅', 141.6055, 42.6341, '015000'],
  // Okinawa is four offices spread over 1000 km.
  ['那覇', 127.6809, 26.2124, '471000'],
  ['宮古島', 125.2811, 24.8055, '473000'],
  ['石垣島', 124.1572, 24.3448, '474000'],
  ['南大東島', 131.2296, 25.8286, '472000'],
]

describe('resolveJmaOffice', () => {
  it.each(CITIES)('resolves %s to office %s', (_name, longitude, latitude, expected) => {
    expect(resolveJmaOffice({ longitude, latitude }).code).toBe(expected)
  })

  it('covers all 58 JMA warning offices exactly once', () => {
    const codes = JMA_OFFICES.map((o) => o.code)
    expect(codes).toHaveLength(58)
    expect(new Set(codes).size).toBe(58)
  })

  it('always answers, including over water and outside Japan', () => {
    // The Sea of Japan, well off Niigata — inside no office box.
    expect(resolveJmaOffice({ longitude: 137.5, latitude: 38.5 }).code).toBeTruthy()
    // Region gating happens before this is ever called, so it only has to not throw.
    expect(resolveJmaOffice({ longitude: 0, latitude: 0 }).code).toBeTruthy()
  })

  it('names the office it chose, so a border miss is visible in the result', () => {
    expect(resolveJmaOffice({ longitude: 136.2233, latitude: 36.0619 }).name).toBe('福井県')
  })
})
