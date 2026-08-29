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
  globalIgnores(['dist', '.traces', 'node_modules']),
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
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/adapters/webmcp/**'],
    rules: restrict(...HOST_GLOBAL_SELECTORS),
  },
  {
    files: ['src/domain/**/*.ts', 'src/ports/**/*.ts', 'src/app/**/*.ts'],
    rules: restrict(...HOST_GLOBAL_SELECTORS, NO_THROW_SELECTOR),
  },
  {
    // Tests describe behaviour, including behaviour at boundaries that throw.
    files: ['**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
])
