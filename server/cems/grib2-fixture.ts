/**
 * Test support: writing GRIB2 messages.
 *
 * Only tests import this. Real retrievals are too large and too licence-encumbered to check in
 * wholesale, so the shapes are built here — from the format specification rather than from the
 * reader, so that a misreading of the spec on one side cannot be cancelled out by the same
 * misreading on the other.
 *
 * One real message *is* checked in, at `fixtures/geo/eu/flood/upstream/`, and the reader is tested
 * against both. This writer covers the cases a single recording cannot: ensembles, bitmaps,
 * scanning modes, and templates the store might emit tomorrow.
 */

export interface Grib2FixtureGrid {
  readonly ni: number
  readonly nj: number
  readonly lat1: number
  readonly lon1: number
  readonly di: number
  readonly dj: number
  /** 0 is west-to-east, north-to-south, which is what every observed retrieval uses. */
  readonly scanMode?: number
}

export interface Grib2FixtureMessage {
  readonly grid: Grib2FixtureGrid
  /** Row-major in the order the scanning mode declares. */
  readonly values: ReadonlyArray<number>
  /** End of the interval the field covers. */
  readonly validTime: Date
  readonly productTemplate?: number
  readonly perturbationNumber?: number
  /** One entry per grid point; 0 excludes the point. Omitted means every point carries a value. */
  readonly bitmap?: ReadonlyArray<number>
  readonly bitsPerValue?: number
}

const u16 = (value: number): Array<number> => [(value >> 8) & 0xff, value & 0xff]
const u32 = (value: number): Array<number> => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

/** GRIB2 stores a negative as a set high bit plus the magnitude, not as two's complement. */
const signMagnitude32 = (value: number): Array<number> =>
  value < 0 ? u32(Math.abs(value) | 0x80000000) : u32(value)

const f32 = (value: number): Array<number> => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setFloat32(0, value, false)
  return [...bytes]
}

const section = (number: number, body: ReadonlyArray<number>): Array<number> => {
  const length = body.length + 5
  return [...u32(length), number, ...body]
}

const identification = (): Array<number> =>
  section(1, [...u16(98), ...u16(0), 0, 0, 0, ...u16(2026), 1, 1, 0, 0, 0, 0, 0])

const gridSection = (grid: Grib2FixtureGrid): Array<number> => {
  const lat2 = grid.lat1 - (grid.nj - 1) * grid.dj
  const lon2 = grid.lon1 + (grid.ni - 1) * grid.di
  return section(3, [
    0, // source of grid definition
    ...u32(grid.ni * grid.nj),
    0, // octets for the optional point list
    0, // interpretation of the point list
    ...u16(0), // grid definition template 3.0
    6, // shape of the earth
    0, ...u32(0), // radius
    0, ...u32(0), // major axis
    0, ...u32(0), // minor axis
    ...u32(grid.ni),
    ...u32(grid.nj),
    ...u32(0), // basic angle
    ...u32(0xffffffff), // subdivisions
    ...signMagnitude32(Math.round(grid.lat1 * 1e6)),
    ...signMagnitude32(Math.round(grid.lon1 * 1e6)),
    48, // resolution and component flags
    ...signMagnitude32(Math.round(lat2 * 1e6)),
    ...signMagnitude32(Math.round(lon2 * 1e6)),
    ...u32(Math.round(grid.di * 1e6)),
    ...u32(Math.round(grid.dj * 1e6)),
    grid.scanMode ?? 0,
  ])
}

/**
 * Sections 4 for the two templates the CEMS-Flood datasets emit.
 *
 * 73 is the forecast's, and carries the three-octet ensemble block that pushes its end-of-interval
 * timestamp three octets later than 72's. That offset difference is precisely what the reader has
 * to get right, so the writer reproduces it rather than padding both to one length.
 */
const productSection = (message: Grib2FixtureMessage): Array<number> => {
  const template = message.productTemplate ?? 73
  const time = message.validTime
  const stamp = [
    ...u16(time.getUTCFullYear()),
    time.getUTCMonth() + 1,
    time.getUTCDate(),
    time.getUTCHours(),
    time.getUTCMinutes(),
    time.getUTCSeconds(),
  ]
  // Octets 10 to 39 (offsets 5 to 34 inside the body) are filler here: the reader reads neither.
  const preamble = [...u16(0), ...u16(template), ...new Array(30).fill(0)]
  // Trailing statistical-process block, again not read; only its presence keeps the lengths right.
  const trailer = [1, ...u32(0), 0, 2, 1, ...u32(24), 0xff, ...u32(0)]

  if (template === 72) {
    // End-of-interval lands at offset 39 from the section start: 5 header octets + 34 of preamble.
    return section(4, [...preamble, ...stamp, ...trailer])
  }
  return section(4, [
    ...preamble,
    0, // type of ensemble forecast
    message.perturbationNumber ?? 0,
    51, // ensemble size
    ...stamp,
    ...trailer,
  ])
}

const dataSections = (message: Grib2FixtureMessage): Array<number> => {
  const bits = message.bitsPerValue ?? 16
  const present = message.bitmap
    ? message.values.filter((_, i) => message.bitmap![i] === 1)
    : [...message.values]

  const reference = present.length === 0 ? 0 : Math.min(...present)
  const packed = present.map((value) => Math.round(value - reference))
  const maximum = 2 ** bits - 1
  for (const value of packed) {
    if (value < 0 || value > maximum) throw new Error(`fixture value ${value} does not fit in ${bits} bits`)
  }

  const representation = section(5, [
    ...u32(present.length),
    ...u16(0), // data representation template 5.0, simple packing
    ...f32(reference),
    ...u16(0), // binary scale
    ...u16(0), // decimal scale
    bits,
    0, // type of original values
  ])

  const bitmapSection = message.bitmap
    ? section(6, [
        0,
        ...(() => {
          const octets = new Array(Math.ceil(message.bitmap.length / 8)).fill(0)
          message.bitmap.forEach((bit, i) => {
            if (bit === 1) octets[i >> 3] |= 1 << (7 - (i & 7))
          })
          return octets
        })(),
      ])
    : section(6, [255])

  const stream: Array<number> = []
  let accumulator = 0
  let held = 0
  for (const value of packed) {
    accumulator = accumulator * 2 ** bits + value
    held += bits
    while (held >= 8) {
      held -= 8
      stream.push(Math.floor(accumulator / 2 ** held) & 0xff)
      accumulator %= 2 ** held
    }
  }
  if (held > 0) stream.push((accumulator << (8 - held)) & 0xff)

  return [...representation, ...bitmapSection, ...section(7, stream)]
}

/** One GRIB2 message. */
export const writeGrib2Message = (message: Grib2FixtureMessage): Array<number> => {
  const body = [
    ...identification(),
    ...gridSection(message.grid),
    ...productSection(message),
    ...dataSections(message),
    0x37, 0x37, 0x37, 0x37, // "7777"
  ]
  const total = body.length + 16
  return [
    0x47, 0x52, 0x49, 0x42, // "GRIB"
    0xff, 0xff, // reserved
    0, // discipline
    2, // edition
    ...u32(0),
    ...u32(total), // total length, as the low half of a 64-bit field
    ...body,
  ]
}

/** A GRIB2 file: messages concatenated, which is all a GRIB2 file ever is. */
export const writeGrib2 = (messages: ReadonlyArray<Grib2FixtureMessage>): Uint8Array =>
  Uint8Array.from(messages.flatMap((message) => writeGrib2Message(message)))
