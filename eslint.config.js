import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * The WebMCP host globals are allowed in exactly one directory. This is the
 * mechanism behind requirement R6.1: the adapter seam is enforced by tooling,
 * because a seam maintained by convention erodes on the first deadline.
 */
const HOST_GLOBAL_SELECTORS = [
  {
    selector: "MemberExpression[object.name='document'][property.name='modelContext']",
    message:
      'document.modelContext may only be used in src/adapters/webmcp/**. Go through ToolHostPort (R6.1).',
  },
  {
    selector: "MemberExpression[object.name='navigator'][property.name='modelContext']",
    message:
      'navigator.modelContext may only be used in src/adapters/webmcp/**. Go through ToolHostPort (R6.1).',
  },
]

/**
 * R6.1 / design §14.3:
 * Upstream host literals are confined to src/adapters/geo/**.
 * maplibre-gl is confined to src/adapters/map/**.
 * @turf/* is confined to src/lib/geometry/**.
 */
const UPSTREAM_HOST_SELECTORS = [
  {
    selector:
      "Literal[value=/api\\.weather\\.gov|hazards\\.fema\\.gov|gis\\.fema\\.gov|cyberjapandata\\.gsi\\.go\\.jp|jma\\.go\\.jp|copernicus\\.eu|meteoalarm\\.org|valhalla1\\.openstreetmap\\.de/]",
    message:
      'Upstream host literals may only be used in src/adapters/geo/**. Route through ports (R6.1).',
  },
  {
    selector:
      "TemplateElement[value.raw=/api\\.weather\\.gov|hazards\\.fema\\.gov|gis\\.fema\\.gov|cyberjapandata\\.gsi\\.go\\.jp|jma\\.go\\.jp|copernicus\\.eu|meteoalarm\\.org|valhalla1\\.openstreetmap\\.de/]",
    message:
      'Upstream host literals may only be used in src/adapters/geo/**. Route through ports (R6.1).',
  },
]

const MAPLIBRE_IMPORT_SELECTOR = {
  selector: "ImportDeclaration[source.value=/^maplibre-gl/]",
  message: 'maplibre-gl may only be imported in src/adapters/map/** (R6.1).',
}

const TURF_IMPORT_SELECTOR = {
  selector: "ImportDeclaration[source.value=/^@turf\\//]",
  message: '@turf/* may only be imported in src/lib/geometry/** (R6.1).',
}

/**
 * R7.1: control flow in the pure and orchestration layers stays in Effect's
 * typed error channel. Adapters and the server boundary are exempt because they
 * sit against APIs that throw.
 */
const NO_THROW_SELECTOR = {
  selector: 'ThrowStatement',
  message:
    'Use a tagged error in the Effect error channel instead of throw (R7.1). Adapters at a host boundary are exempt.',
}

/**
 * ESLint config objects REPLACE a rule's options rather than merging them, so a
 * later block that also sets `no-restricted-syntax` would silently drop the
 * host-global ban. Every block therefore states the full selector list it wants.
 */
const restrict = (...selectors) => ({ 'no-restricted-syntax': ['error', ...selectors] })

export default defineConfig([
  // `movie` is a separate Remotion package with its own ESLint/TypeScript
  // versions and quality gate. Letting the root ESLint walk into its nested
  // node_modules mixes two parser scope-manager versions and crashes before
  // either project can report a real lint finding. Runtime caches are data, not
  // source, and can contain thousands of large binary/JSON retrievals.
  globalIgnores(['dist', '.traces', '.cache', 'movie', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Base src restrictions across different modules
  {
    files: ['src/adapters/webmcp/**/*.{ts,tsx}'],
    rules: restrict(...UPSTREAM_HOST_SELECTORS, MAPLIBRE_IMPORT_SELECTOR, TURF_IMPORT_SELECTOR),
  },
  {
    files: ['src/adapters/geo/**/*.{ts,tsx}'],
    rules: restrict(...HOST_GLOBAL_SELECTORS, MAPLIBRE_IMPORT_SELECTOR, TURF_IMPORT_SELECTOR),
  },
  {
    files: ['src/adapters/map/**/*.{ts,tsx}'],
    rules: restrict(...HOST_GLOBAL_SELECTORS, ...UPSTREAM_HOST_SELECTORS, TURF_IMPORT_SELECTOR),
  },
  {
    files: ['src/lib/geometry/**/*.{ts,tsx}'],
    rules: restrict(...HOST_GLOBAL_SELECTORS, ...UPSTREAM_HOST_SELECTORS, MAPLIBRE_IMPORT_SELECTOR),
  },
  {
    files: ['src/domain/**/*.ts', 'src/ports/**/*.ts', 'src/app/**/*.ts'],
    rules: restrict(
      ...HOST_GLOBAL_SELECTORS,
      ...UPSTREAM_HOST_SELECTORS,
      MAPLIBRE_IMPORT_SELECTOR,
      TURF_IMPORT_SELECTOR,
      NO_THROW_SELECTOR,
    ),
  },
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/toolsets/**/*.{ts,tsx}', 'src/*.{ts,tsx}'],
    rules: restrict(
      ...HOST_GLOBAL_SELECTORS,
      ...UPSTREAM_HOST_SELECTORS,
      MAPLIBRE_IMPORT_SELECTOR,
      TURF_IMPORT_SELECTOR,
    ),
  },
  {
    // The inspector opts out of React Compiler with `'use no memo'`: TanStack Virtual owns mutable
    // scroll and row-measurement state. Its incompatible-library warning is therefore inapplicable
    // to this one, deliberately non-compiled component.
    files: ['src/ui/inspector/InspectorPane.tsx'],
    rules: { 'react-hooks/incompatible-library': 'off' },
  },
  {
    // Tests describe behaviour, including behaviour at boundaries that throw.
    files: ['**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
])
