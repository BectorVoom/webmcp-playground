import fukuiTile from '../../../../fixtures/geo/jp/flood/upstream/gsi-fukui-z14.json'
import mabiTile from '../../../../fixtures/geo/jp/flood/upstream/gsi-mabi-z14.json'

/**
 * Real GSI hazard tiles, for tests.
 *
 * Stored as run-length-encoded RGBA rather than as PNG so the suite needs no image decoder: the
 * browser's `createImageBitmap` does not exist under jsdom, which is the same reason
 * `JpFloodProvider` takes its decoder as a constructor argument.
 *
 * They exist because every raster test before them invented its own tile — a solid block a few
 * pixels across — and a solid block is nothing like what GSI serves. The Fukui tile below holds
 * some 5 000 separate pixel runs across four depth bands, and it is that shape, not the synthetic
 * one, that took the vectoriser from milliseconds to never finishing.
 */

interface TileFixture {
  readonly width: number
  readonly height: number
  readonly palette: ReadonlyArray<ReadonlyArray<number>>
  readonly runs: ReadonlyArray<ReadonlyArray<number>>
  readonly upstreamUrl: string
  readonly place: string
}

export interface DecodedFixtureTile {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

const expand = (fixture: TileFixture): DecodedFixtureTile => {
  const { width, height, palette, runs } = fixture
  const data = new Uint8ClampedArray(width * height * 4)
  let pixel = 0
  for (const [index, count] of runs) {
    const colour = index === undefined || index < 0 ? undefined : palette[index]
    for (let i = 0; i < (count ?? 0); i++, pixel++) {
      if (!colour) continue
      const offset = pixel * 4
      data[offset] = colour[0] ?? 0
      data[offset + 1] = colour[1] ?? 0
      data[offset + 2] = colour[2] ?? 0
      data[offset + 3] = 255
    }
  }
  return { data, width, height }
}

/** A dense tile from the centre of Fukui: four depth bands, ~5 000 pixel runs. */
export const fukuiStationTile = (): DecodedFixtureTile => expand(fukuiTile as TileFixture)

/** Mabi, Kurashiki — the sample that carries the 10–20 m band. */
export const mabiTile10to20m = (): DecodedFixtureTile => expand(mabiTile as TileFixture)

export const FUKUI_TILE = { z: 14, x: 14391, y: 6430 } as const
export const MABI_TILE = { z: 14, x: 14276, y: 6509 } as const
