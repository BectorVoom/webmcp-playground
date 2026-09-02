import type { HazardClass } from '../domain/hazard'

/**
 * The one place a hazard class is given a colour.
 *
 * The map and the legend used to hold separate hand-written colour tables, and they had drifted on
 * every single band: the map painted `extreme` a dark maroon while the legend showed purple, and
 * `low` green while the legend showed pale yellow. Nobody noticed because `extreme` almost never
 * reached the screen — until the GSI depth legend was corrected, 5–10 m water stopped being
 * misfiled as `high`, and a brown that appeared nowhere in the legend turned up on the map.
 *
 * This is the same failure the layer-id lists in `adapters/map/maplibre.ts` already had once. Two
 * lists that must agree, and no compiler forcing them to, is a drift waiting to happen.
 */
/**
 * How a class is hatched, on top of its fill.
 *
 * R5.7 requires hazard class to survive more than colour, and until now only colour carried it —
 * on a ramp whose axis a red-green deficiency compresses. Each class therefore also gets a texture,
 * and the textures differ in *kind* (spacing and direction) rather than only in density, so they
 * stay apart in greyscale.
 */
export type HazardHatch = 'cross' | 'diagonal' | 'back-diagonal' | 'horizontal' | 'dots'

export interface HazardStyle {
  readonly hazardClass: HazardClass
  /** Polygon fill, drawn at `FLOOD_FILL_OPACITY`. */
  readonly fill: string
  /** Polygon outline. */
  readonly line: string
  /** Overlaid texture, so depth is legible without colour (R5.7). */
  readonly hatch: HazardHatch
  /** Short name, as the legend prints it. */
  readonly label: string
  /** The depth band this class covers, in the words the reader needs. */
  readonly depthLabel: string
  /** Why this class exists at all, where that is not obvious from the depth. */
  readonly note?: string
}

/**
 * Most severe first, which is the order the legend reads best in.
 *
 * **The ramp carries no green, on purpose.** It used to run green → yellow → red → dark maroon,
 * which is the one axis a red-green deficiency flattens, and its `low` green (`#22c55e`) sat next
 * to the `#16a34a` that means "shelter assessed clear" on the same map — one green for shallow
 * flooding and another for safe. It is now a sequential yellow-orange-red ramp that is monotonic
 * in lightness, so it also survives being printed or desaturated.
 */
export const HAZARD_PALETTE: ReadonlyArray<HazardStyle> = [
  {
    hazardClass: 'extreme',
    fill: '#800026',
    line: '#4a0014',
    hatch: 'cross',
    label: 'Extreme',
    depthLabel: '5.0 m and deeper',
  },
  {
    hazardClass: 'high',
    fill: '#e31a1c',
    line: '#99000d',
    hatch: 'diagonal',
    label: 'High',
    depthLabel: '3.0 – 5.0 m',
  },
  {
    hazardClass: 'moderate',
    fill: '#fd8d3c',
    line: '#b34700',
    hatch: 'back-diagonal',
    label: 'Moderate',
    depthLabel: '0.5 – 3.0 m',
  },
  {
    hazardClass: 'low',
    fill: '#fed976',
    line: '#b8860b',
    hatch: 'dots',
    label: 'Low',
    depthLabel: 'below 0.5 m',
  },
  {
    // Reachable: GSI paints a couple of fills that appear in no published depth legend, and this
    // is what they become. The area really is mapped as inundated — only the depth is unknown — so
    // it must be drawn, and it must be named, or a grey patch reads as a rendering fault.
    hazardClass: 'unclassified',
    fill: '#64748b',
    line: '#475569',
    hatch: 'horizontal',
    label: 'Depth unreadable',
    depthLabel: 'inundated, depth unknown',
    note: 'Mapped as flooded by the authority, in a colour outside its published legend.',
  },
]

export const FLOOD_FILL_OPACITY = 0.55

const styleOf = (hazardClass: HazardClass): HazardStyle =>
  HAZARD_PALETTE.find((entry) => entry.hazardClass === hazardClass) ?? HAZARD_PALETTE[4]!

export const hazardFill = (hazardClass: HazardClass): string => styleOf(hazardClass).fill
export const hazardLine = (hazardClass: HazardClass): string => styleOf(hazardClass).line

/**
 * Builds the MapLibre `match` expression for a hazard-class-driven paint property.
 *
 * Returned as a flat array because that is the wire shape MapLibre wants; the point is that it is
 * generated from `HAZARD_PALETTE` rather than typed out a second time. The trailing entry is the
 * fallback for a feature carrying no recognisable class, which gets the same treatment as one
 * whose depth could not be read — grey, and never mistaken for a depth.
 */
export const hazardMatchExpression = (
  property: 'fill' | 'line',
): [string, ...Array<unknown>] => [
  'match',
  ['get', 'hazardClass'],
  ...HAZARD_PALETTE.flatMap((entry) => [entry.hazardClass, entry[property]]),
  styleOf('unclassified')[property],
]

/** Side of a hatch tile, in pixels. A power of two so MapLibre can mipmap it without artefacts. */
export const HATCH_SIZE = 16

/** Ink the hatch is drawn in: dark and part-transparent, so the class colour still reads through. */
const HATCH_INK = { r: 17, g: 24, b: 39, a: 150 } as const

/** MapLibre image id for a class's hatch. */
export const hatchImageId = (hazardClass: HazardClass): string =>
  `hazard-hatch-${styleOf(hazardClass).hatch}`

/**
 * Renders a hatch as raw RGBA.
 *
 * Built pixel by pixel rather than drawn on a canvas because there is no canvas to draw on: the
 * adapter runs before any sprite is loaded, and the test environment is jsdom. MapLibre's
 * `addImage` takes exactly this shape, so the pattern needs no sprite server and no image request.
 */
export const hatchImage = (
  hatch: HazardHatch,
  size = HATCH_SIZE,
): { readonly width: number; readonly height: number; readonly data: Uint8Array } => {
  const data = new Uint8Array(size * size * 4)

  const ink = (x: number, y: number): void => {
    const offset = (y * size + x) * 4
    data[offset] = HATCH_INK.r
    data[offset + 1] = HATCH_INK.g
    data[offset + 2] = HATCH_INK.b
    data[offset + 3] = HATCH_INK.a
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Spacings differ as well as directions: two textures that differ only in angle are hard to
      // tell apart at the size a flood polygon is actually drawn.
      const on =
        hatch === 'cross'
          ? (x + y) % 4 === 0 || (x - y + size) % 4 === 0
          : hatch === 'diagonal'
            ? (x + y) % 6 === 0
            : hatch === 'back-diagonal'
              ? (x - y + size) % 8 === 0
              : hatch === 'horizontal'
                ? y % 5 === 0
                : x % 8 === 3 && y % 8 === 3 // dots, the sparsest of the five
      if (on) ink(x, y)
    }
  }

  return { width: size, height: size, data }
}

/** Every hatch that has to be registered with the map, keyed by the id the paint expression uses. */
export const hatchImages = (): ReadonlyArray<{
  readonly id: string
  readonly image: ReturnType<typeof hatchImage>
}> =>
  Array.from(new Set(HAZARD_PALETTE.map((entry) => entry.hatch))).map((hatch) => ({
    id: `hazard-hatch-${hatch}`,
    image: hatchImage(hatch),
  }))

/**
 * The same hatch as CSS, for the legend's swatches.
 *
 * Derived from the same `hatch` field the map's raster pattern is built from, so a class cannot be
 * hatched one way on the map and another in the legend — which is precisely the drift that let the
 * two disagree about every colour band before `HAZARD_PALETTE` existed. It is a gradient rather
 * than the identical pixels: a 16 px raster scaled into a 14 px swatch reads as noise, and what the
 * legend has to convey is *which texture means which depth*, not a pixel match.
 */
export const hatchCss = (hatch: HazardHatch): string => {
  const ink = `rgba(17, 24, 39, 0.6)`
  switch (hatch) {
    case 'cross':
      return (
        `repeating-linear-gradient(45deg, ${ink} 0 1px, transparent 1px 4px), ` +
        `repeating-linear-gradient(-45deg, ${ink} 0 1px, transparent 1px 4px)`
      )
    case 'diagonal':
      return `repeating-linear-gradient(45deg, ${ink} 0 1px, transparent 1px 5px)`
    case 'back-diagonal':
      return `repeating-linear-gradient(-45deg, ${ink} 0 1px, transparent 1px 7px)`
    case 'horizontal':
      return `repeating-linear-gradient(0deg, ${ink} 0 1px, transparent 1px 5px)`
    case 'dots':
      return `radial-gradient(${ink} 0.5px, transparent 0.6px)`
  }
}

/** The hatch a class is drawn with, for callers that render it themselves. */
export const hazardHatch = (hazardClass: HazardClass): HazardHatch => styleOf(hazardClass).hatch

/**
 * `fill-pattern` expression, selecting the hatch for each feature's class.
 *
 * Drawn as a second fill layer over the coloured one rather than replacing it: `fill-pattern`
 * overrides `fill-color`, so a single patterned layer would encode the class in texture *instead*
 * of colour, which trades one single-channel encoding for another.
 */
export const hazardHatchExpression = (): [string, ...Array<unknown>] => [
  'match',
  ['get', 'hazardClass'],
  ...HAZARD_PALETTE.flatMap((entry) => [entry.hazardClass, `hazard-hatch-${entry.hatch}`]),
  `hazard-hatch-${styleOf('unclassified').hatch}`,
]
