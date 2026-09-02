/**
 * Reading the GRIB2 a Copernicus retrieval comes back as.
 *
 * The store offers two formats and the choice is not free. Its `netcdf` output is written by
 * `cfgrib`, which produces **NetCDF-4 — HDF5 underneath** (verified 2026-08-31: the file starts
 * `89 48 44 46`). Reading that means a B-tree, chunked storage and deflate filters, which in
 * practice means an HDF5 library. Its `grib2` output, for the same request, is **grid definition
 * template 3.0 (regular lat/lon) with data representation template 5.0 (simple packing)** — an
 * unambiguous, uncompressed layout that is a few hundred lines to read and no dependency at all.
 * So this pipeline asks for GRIB2.
 *
 * What is verified against real retrievals from `cems-glofas-forecast`, rather than assumed:
 *
 *   - 102 messages for 51 members × 2 lead times, one message per member per lead.
 *   - One grid definition, identical in every message.
 *   - Product definition template **73** throughout, an ECMWF template that does *not* follow the
 *     common octet 10–34 layout — its `forecastTime` field reads as nonsense at the standard
 *     offset. Its end-of-interval timestamp and perturbation number are read at the offsets in
 *     `PRODUCT_LAYOUTS` below, which were located empirically and then checked: the timestamps
 *     came out as exactly two values, 24 h and 48 h after the run, and the perturbation numbers as
 *     exactly 0–50.
 *
 * That last point is why `readProduct` validates what it reads and throws rather than guessing.
 * A misplaced offset here would not crash — it would silently group the wrong messages together
 * and report a confident, wrong exceedance probability.
 */

export type BinaryFormat = 'grib2' | 'netcdf4-hdf5' | 'netcdf-classic' | 'zip' | 'unknown'

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>): boolean =>
  signature.every((byte, i) => bytes[i] === byte)

/** What the bytes actually are, from their magic number. */
export const sniffFormat = (bytes: Uint8Array): BinaryFormat => {
  if (startsWith(bytes, [0x47, 0x52, 0x49, 0x42])) return 'grib2' // "GRIB"
  if (startsWith(bytes, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) return 'netcdf4-hdf5'
  if (startsWith(bytes, [0x43, 0x44, 0x46])) return 'netcdf-classic' // "CDF"
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip' // "PK\x03\x04"
  return 'unknown'
}

/** Human-facing, because every one of these is fixed by changing the request, not the reader. */
export const describeFormat = (format: BinaryFormat): string => {
  switch (format) {
    case 'grib2':
      return 'GRIB2'
    case 'netcdf4-hdf5':
      return "NetCDF-4 (HDF5), which is what the store's data_format=netcdf produces — request grib2 instead"
    case 'netcdf-classic':
      return 'classic NetCDF, which this pipeline no longer reads — request grib2'
    case 'zip':
      return 'a zip archive — request download_format=unarchived'
    case 'unknown':
      return 'not a recognised binary format; it is most likely a JSON or HTML error page'
  }
}

export class Grib2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Grib2Error'
  }
}

/**
 * GRIB2 writes a negative number by setting the high bit and storing the magnitude, *not* in two's
 * complement. Read as two's complement, a scale factor of −13 becomes −32 755 and every value in
 * the message is wrong by a factor of 2^32742.
 */
const signMagnitude = (raw: number, bits: number): number => {
  const signBit = 1 << (bits - 1)
  return (raw & signBit) !== 0 ? -(raw & (signBit - 1)) : raw
}

export interface Grib2Grid {
  /** Points along a parallel (columns) and a meridian (rows). */
  readonly ni: number
  readonly nj: number
  /** Latitude and longitude of the first grid point, degrees. */
  readonly lat1: number
  readonly lon1: number
  readonly lat2: number
  readonly lon2: number
  /** Increments, degrees. */
  readonly di: number
  readonly dj: number
}

export interface Grib2Message {
  readonly grid: Grib2Grid
  /**
   * The field, row-major and always normalised to north-first, west-first regardless of the
   * message's own scanning mode. Points a bitmap excludes are `NaN`.
   */
  readonly values: Float64Array
  /** End of the interval the field covers, epoch ms — for `dis24`, the day it is the mean over. */
  readonly validTime: number
  /** Ensemble member id, where the product template carries one. */
  readonly perturbationNumber?: number
  readonly productTemplate: number
}

interface ProductLayout {
  /** Offset from the section start of the 7-octet end-of-interval timestamp. */
  readonly validTimeOffset: number
  /** Offset of the single-octet perturbation number, where the template has one. */
  readonly perturbationOffset?: number
}

/**
 * Where each product definition template keeps the two fields this reader needs.
 *
 * Offsets are from the start of section 4, zero-indexed, so an octet number `n` in the GRIB2
 * specification is `n - 1` here. Only templates that have been seen in a real retrieval are
 * listed: an unlisted one throws, which is the correct outcome — reading an unknown template at a
 * guessed offset produces plausible numbers rather than an error.
 */
const PRODUCT_LAYOUTS: Record<number, ProductLayout> = {
  /**
   * `cems-glofas-historical`, the consolidated reanalysis. Deterministic, so no perturbation
   * number. Verified 2026-08-31: three days requested came back as intervals ending 2020-01-02,
   * -03 and -04, each the end of its own 24-hour mean.
   */
  72: { validTimeOffset: 39 },
  /**
   * `cems-glofas-forecast`. The same template plus the three-octet ensemble block — type of
   * forecast, perturbation number, ensemble size — which is exactly why its interval sits three
   * octets later and its section is 66 bytes against 72's 63. Verified 2026-08-31 across 102
   * messages: two interval ends 24 h apart, perturbation numbers 0–50.
   */
  73: { validTimeOffset: 42, perturbationOffset: 40 },
}

/** Registers a template's layout. Exported so the offsets stay testable and greppable. */
export const registerProductLayout = (template: number, layout: ProductLayout): void => {
  PRODUCT_LAYOUTS[template] = layout
}

export const knownProductTemplates = (): ReadonlyArray<number> =>
  Object.keys(PRODUCT_LAYOUTS).map(Number)

const readGrid = (view: DataView, at: number): Grib2Grid => {
  const template = view.getUint16(at + 12)
  if (template !== 0) {
    throw new Grib2Error(
      `grid definition template ${template} is not the regular latitude/longitude grid (0) this ` +
        'reader handles',
    )
  }
  return {
    ni: view.getUint32(at + 30),
    nj: view.getUint32(at + 34),
    lat1: signMagnitude(view.getUint32(at + 46), 32) / 1e6,
    lon1: signMagnitude(view.getUint32(at + 50), 32) / 1e6,
    lat2: signMagnitude(view.getUint32(at + 55), 32) / 1e6,
    lon2: signMagnitude(view.getUint32(at + 59), 32) / 1e6,
    di: view.getUint32(at + 63) / 1e6,
    dj: view.getUint32(at + 67) / 1e6,
  }
}

interface Product {
  readonly template: number
  readonly validTime: number
  readonly perturbationNumber?: number
}

const readProduct = (view: DataView, at: number): Product => {
  const template = view.getUint16(at + 7)
  const layout = PRODUCT_LAYOUTS[template]
  if (layout === undefined) {
    throw new Grib2Error(
      `product definition template ${template} is not one this reader knows where to read a valid ` +
        `time from (it knows ${knownProductTemplates().join(', ')}). Reading it at a guessed offset ` +
        'would group the wrong messages together and report a confident, wrong probability, so it ' +
        'refuses instead. Add the template to PRODUCT_LAYOUTS once its offsets are confirmed.',
    )
  }

  const base = at + layout.validTimeOffset
  const year = view.getUint16(base)
  const month = view.getUint8(base + 2)
  const day = view.getUint8(base + 3)
  const hour = view.getUint8(base + 4)
  const minute = view.getUint8(base + 5)
  const second = view.getUint8(base + 6)

  // The offsets were located empirically; this is what stops a wrong one passing as data.
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) {
    throw new Grib2Error(
      `template ${template} produced an implausible valid time ${year}-${month}-${day} ${hour}h at ` +
        `offset ${layout.validTimeOffset}; its layout in PRODUCT_LAYOUTS is wrong for this file`,
    )
  }

  return {
    template,
    validTime: Date.UTC(year, month - 1, day, hour, minute, second),
    perturbationNumber:
      layout.perturbationOffset === undefined ? undefined : view.getUint8(at + layout.perturbationOffset),
  }
}

interface Packing {
  readonly referenceValue: number
  readonly binaryScale: number
  readonly decimalScale: number
  readonly bitsPerValue: number
  readonly valueCount: number
}

const readPacking = (view: DataView, at: number): Packing => {
  const template = view.getUint16(at + 9)
  if (template !== 0) {
    throw new Grib2Error(
      `data representation template ${template} is not simple packing (0); this reader does not ` +
        'decode complex packing, JPEG 2000 or CCSDS',
    )
  }
  return {
    valueCount: view.getUint32(at + 5),
    referenceValue: view.getFloat32(at + 11),
    binaryScale: signMagnitude(view.getUint16(at + 15), 16),
    decimalScale: signMagnitude(view.getUint16(at + 17), 16),
    bitsPerValue: view.getUint8(at + 19),
  }
}

/**
 * Which grid points carry a value.
 *
 * `255` means every point does. Anything else is a bit per point, most significant first, and the
 * packed values in section 7 cover only the set bits — so a bitmap read wrongly does not lose one
 * value, it shifts every subsequent one into the wrong cell.
 */
const readBitmap = (bytes: Uint8Array, at: number, pointCount: number): Uint8Array | undefined => {
  if (bytes[at + 5] === 255) return undefined
  const bitmap = new Uint8Array(pointCount)
  const data = at + 6
  for (let i = 0; i < pointCount; i++) {
    bitmap[i] = (bytes[data + (i >> 3)]! >> (7 - (i & 7))) & 1
  }
  return bitmap
}

/** Unpacks the `nbits`-wide unsigned integers section 7 is a bit stream of. */
const unpack = (bytes: Uint8Array, at: number, count: number, bits: number): Float64Array => {
  const out = new Float64Array(count)
  if (bits === 0) return out // a constant field: every value is the reference value

  let bitPosition = 0
  for (let i = 0; i < count; i++) {
    let value = 0
    for (let bit = 0; bit < bits; bit++) {
      const byte = bytes[at + (bitPosition >> 3)]
      if (byte === undefined) {
        throw new Grib2Error(`section 7 ended after ${i} of ${count} values`)
      }
      value = value * 2 + ((byte >> (7 - (bitPosition & 7))) & 1)
      bitPosition++
    }
    out[i] = value
  }
  return out
}

/**
 * Normalises a message's points into north-first, west-first row-major order.
 *
 * The scanning mode says which corner the data starts at. Ignoring it does not fail — it produces
 * a field mirrored about an axis, which on a map is a flood drawn on the opposite bank.
 */
const orient = (values: Float64Array, ni: number, nj: number, scanMode: number): Float64Array => {
  const westToEast = (scanMode & 0x80) === 0
  const northToSouth = (scanMode & 0x40) === 0
  if ((scanMode & 0x20) !== 0) {
    throw new Grib2Error('scanning mode stores adjacent points along a meridian, which is not handled')
  }
  if (westToEast && northToSouth) return values

  const out = new Float64Array(values.length)
  for (let row = 0; row < nj; row++) {
    for (let column = 0; column < ni; column++) {
      const sourceRow = northToSouth ? row : nj - 1 - row
      const sourceColumn = westToEast ? column : ni - 1 - column
      out[row * ni + column] = values[sourceRow * ni + sourceColumn]!
    }
  }
  return out
}

/**
 * Every message in a GRIB2 file, decoded.
 *
 * A file is a plain concatenation of self-describing messages, each with its own grid, product and
 * data sections, so this walks them by their declared lengths rather than searching for markers.
 */
export const parseGrib2 = (bytes: Uint8Array): ReadonlyArray<Grib2Message> => {
  const format = sniffFormat(bytes)
  if (format !== 'grib2') {
    throw new Grib2Error(`not a GRIB2 file: it is ${describeFormat(format)}`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const messages: Array<Grib2Message> = []
  let at = 0

  while (at + 16 <= bytes.byteLength) {
    if (String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!) !== 'GRIB') break

    const edition = bytes[at + 7]
    if (edition !== 2) throw new Grib2Error(`GRIB edition ${edition} is not supported; this reads edition 2`)

    const totalLength = Number(view.getBigUint64(at + 8))
    if (totalLength <= 0 || at + totalLength > bytes.byteLength) {
      throw new Grib2Error(
        `message at byte ${at} declares ${totalLength} bytes, past the end of a ${bytes.byteLength}-byte file`,
      )
    }

    let grid: Grib2Grid | undefined
    let scanMode = 0
    let product: Product | undefined
    let packing: Packing | undefined
    let bitmap: Uint8Array | undefined
    let dataAt: number | undefined

    let section = at + 16
    while (section < at + totalLength - 4) {
      const marker = String.fromCharCode(
        bytes[section]!,
        bytes[section + 1]!,
        bytes[section + 2]!,
        bytes[section + 3]!,
      )
      if (marker === '7777') break

      const length = view.getUint32(section)
      if (length <= 0) throw new Grib2Error(`zero-length section at byte ${section}`)
      const number = bytes[section + 4]

      if (number === 3) {
        grid = readGrid(view, section)
        scanMode = bytes[section + 71]!
      } else if (number === 4) {
        product = readProduct(view, section)
      } else if (number === 5) {
        packing = readPacking(view, section)
      } else if (number === 6) {
        bitmap = readBitmap(bytes, section, (grid?.ni ?? 0) * (grid?.nj ?? 0))
      } else if (number === 7) {
        dataAt = section + 5
      }

      section += length
    }

    if (grid === undefined || product === undefined || packing === undefined || dataAt === undefined) {
      throw new Grib2Error(`message at byte ${at} is missing a grid, product, packing or data section`)
    }

    const pointCount = grid.ni * grid.nj
    const scale = 2 ** packing.binaryScale / 10 ** packing.decimalScale
    const reference = packing.referenceValue / 10 ** packing.decimalScale
    const packed = unpack(bytes, dataAt, packing.valueCount, packing.bitsPerValue)

    const values = new Float64Array(pointCount)
    if (bitmap === undefined) {
      if (packing.valueCount !== pointCount) {
        throw new Grib2Error(
          `message carries ${packing.valueCount} values for a ${pointCount}-point grid and no bitmap`,
        )
      }
      for (let i = 0; i < pointCount; i++) values[i] = reference + packed[i]! * scale
    } else {
      let taken = 0
      for (let i = 0; i < pointCount; i++) {
        values[i] = bitmap[i] === 1 ? reference + packed[taken++]! * scale : Number.NaN
      }
    }

    messages.push({
      grid,
      values: orient(values, grid.ni, grid.nj, scanMode),
      validTime: product.validTime,
      perturbationNumber: product.perturbationNumber,
      productTemplate: product.template,
    })

    at += totalLength
  }

  if (messages.length === 0) throw new Grib2Error('the file contains no GRIB2 messages')
  return messages
}
