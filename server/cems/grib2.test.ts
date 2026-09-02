import { describe, expect, it } from 'vitest'
import { describeFormat, Grib2Error, parseGrib2, sniffFormat } from './grib2'
import { writeGrib2 } from './grib2-fixture'
import recorded from '../../fixtures/geo/eu/flood/upstream/glofas-forecast-cologne.grib.json'

const grid = { ni: 4, nj: 3, lat1: 51.1, lon1: 6.6, di: 0.05, dj: 0.05 }
const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]

describe('sniffFormat', () => {
  it('names each format a Copernicus retrieval can come back as', () => {
    expect(sniffFormat(new Uint8Array([0x47, 0x52, 0x49, 0x42]))).toBe('grib2')
    expect(sniffFormat(new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('netcdf4-hdf5')
    expect(sniffFormat(new Uint8Array([0x43, 0x44, 0x46, 0x01]))).toBe('netcdf-classic')
    expect(sniffFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip')
  })

  /**
   * The store's own `data_format: netcdf` produces this, which is why the message says what to ask
   * for instead rather than just refusing.
   */
  it('explains how to fix an HDF5 reply rather than only rejecting it', () => {
    expect(describeFormat('netcdf4-hdf5')).toMatch(/request grib2/)
    const hdf5 = new Uint8Array(64)
    hdf5.set([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => parseGrib2(hdf5)).toThrow(/NetCDF-4/)
  })

  it('does not mistake a JSON error body for data', () => {
    const json = new TextEncoder().encode('{"detail":"licence not accepted"}')
    expect(sniffFormat(json)).toBe('unknown')
    expect(() => parseGrib2(json)).toThrow(/error page/)
  })
})

describe('parseGrib2', () => {
  it('reads the grid definition', () => {
    const [message] = parseGrib2(writeGrib2([{ grid, values, validTime: new Date(Date.UTC(2026, 7, 31)) }]))

    expect(message!.grid.ni).toBe(4)
    expect(message!.grid.nj).toBe(3)
    expect(message!.grid.lat1).toBeCloseTo(51.1, 6)
    expect(message!.grid.lon1).toBeCloseTo(6.6, 6)
    expect(message!.grid.di).toBeCloseTo(0.05, 9)
  })

  it('unpacks the values', () => {
    const [message] = parseGrib2(writeGrib2([{ grid, values, validTime: new Date(Date.UTC(2026, 7, 31)) }]))
    expect(Array.from(message!.values)).toEqual(values)
  })

  it('reads the valid time and the perturbation number', () => {
    const [message] = parseGrib2(
      writeGrib2([
        { grid, values, validTime: new Date(Date.UTC(2026, 7, 31, 6)), perturbationNumber: 17 },
      ]),
    )
    expect(new Date(message!.validTime).toISOString()).toBe('2026-08-31T06:00:00.000Z')
    expect(message!.perturbationNumber).toBe(17)
  })

  /**
   * The historical dataset's template. Its end-of-interval sits three octets earlier than the
   * forecast's, because it has no ensemble block — reading one at the other's offset is the
   * mistake this pins down.
   */
  it('reads template 72, whose timestamp sits at a different offset', () => {
    const [message] = parseGrib2(
      writeGrib2([
        { grid, values, validTime: new Date(Date.UTC(2020, 0, 2)), productTemplate: 72 },
      ]),
    )
    expect(message!.productTemplate).toBe(72)
    expect(new Date(message!.validTime).toISOString()).toBe('2020-01-02T00:00:00.000Z')
    expect(message!.perturbationNumber).toBeUndefined()
  })

  it('reads every message in a multi-message file', () => {
    const bytes = writeGrib2([
      { grid, values, validTime: new Date(Date.UTC(2026, 7, 31)), perturbationNumber: 0 },
      { grid, values: values.map((v) => v + 1), validTime: new Date(Date.UTC(2026, 7, 31)), perturbationNumber: 1 },
      { grid, values: values.map((v) => v + 2), validTime: new Date(Date.UTC(2026, 8, 1)), perturbationNumber: 0 },
    ])
    const messages = parseGrib2(bytes)

    expect(messages).toHaveLength(3)
    expect(messages[1]!.values[0]).toBe(11)
    expect(messages[2]!.perturbationNumber).toBe(0)
  })

  /**
   * A wrong offset does not crash — it produces a plausible number. Refusing an unknown template
   * is what stops the wrong messages being grouped and a confident, wrong probability reported.
   */
  it('refuses a product template it has no verified offsets for', () => {
    const bytes = writeGrib2([{ grid, values, validTime: new Date(Date.UTC(2026, 7, 31)), productTemplate: 8 }])
    expect(() => parseGrib2(bytes)).toThrow(Grib2Error)
    expect(() => parseGrib2(bytes)).toThrow(/template 8 is not one this reader knows/)
  })

  it('excludes bitmapped-out points as NaN without shifting the rest', () => {
    const bitmap = [1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const [message] = parseGrib2(
      writeGrib2([{ grid, values, validTime: new Date(Date.UTC(2026, 7, 31)), bitmap }]),
    )

    expect(Number.isNaN(message!.values[2]!)).toBe(true)
    // The value after the gap must still be its own, not the one shifted up into it.
    expect(message!.values[3]).toBe(40)
    expect(message!.values[11]).toBe(120)
  })

  /**
   * A south-first message drawn without flipping is a flood mapped onto the opposite bank — it
   * fails as a plausible picture, never as an error.
   */
  it('normalises a south-to-north scanning mode to north-first rows', () => {
    const southFirst = { ...grid, scanMode: 0x40 }
    const [message] = parseGrib2(
      writeGrib2([{ grid: southFirst, values, validTime: new Date(Date.UTC(2026, 7, 31)) }]),
    )
    // Last row of the file becomes the first row of the grid.
    expect(Array.from(message!.values.slice(0, 4))).toEqual([90, 100, 110, 120])
    expect(Array.from(message!.values.slice(8, 12))).toEqual([10, 20, 30, 40])
  })

  it('rejects a truncated file rather than returning a short field', () => {
    const bytes = writeGrib2([{ grid, values, validTime: new Date(Date.UTC(2026, 7, 31)) }])
    expect(() => parseGrib2(bytes.subarray(0, bytes.length - 20))).toThrow(/past the end|ended after/)
  })
})

/**
 * The recorded message is a real reply from `cems-glofas-forecast` — the control run for 2026-08-30
 * over Cologne. It is here because every other test in this file writes its own fixture, and a
 * writer built from the same reading of the specification as the reader would agree with it even
 * if both were wrong.
 */
describe('parseGrib2 against a recorded retrieval', () => {
  const bytes = Uint8Array.from(Buffer.from(recorded.base64, 'base64'))

  it('reads the store’s own message', () => {
    const messages = parseGrib2(bytes)
    expect(messages).toHaveLength(1)

    const message = messages[0]!
    expect(message.productTemplate).toBe(73)
    expect(message.grid).toMatchObject({ ni: 16, nj: 12 })
    expect(message.grid.di).toBeCloseTo(0.05, 6)
    expect(message.grid.lat1).toBeCloseTo(51.175, 6)
    expect(message.grid.lon1).toBeCloseTo(6.625, 6)
    // A 24-hour lead on a run initialised 2026-08-30 00Z.
    expect(new Date(message.validTime).toISOString()).toBe('2026-08-31T00:00:00.000Z')
    expect(message.perturbationNumber).toBe(0)
  })

  /**
   * The Rhine at Cologne, in late-summer low flow. This is the assertion that says the packing was
   * undone correctly: a scale factor read as two's complement rather than sign-magnitude, or a
   * skipped reference value, lands nowhere near a thousand cubic metres a second.
   */
  it('recovers physically plausible discharges', () => {
    const message = parseGrib2(bytes)[0]!
    expect(message.values).toHaveLength(192)

    const river = [...message.values].filter((value) => value > 500)
    expect(river.length).toBeGreaterThan(5)
    for (const value of river) expect(value).toBeGreaterThan(900)
    for (const value of river) expect(value).toBeLessThan(2000)

    // And most of the box is not a river at all.
    expect([...message.values].filter((value) => value < 5).length).toBeGreaterThan(100)
  })
})
