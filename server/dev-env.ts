/**
 * Merging a parsed `.env` into a process environment, without clobbering it.
 *
 * Extracted from `vite.config.ts` so the rule can be tested. The rule is small and the cost of
 * getting it wrong is not: overriding a real variable would make `GEO_DATA_MODE=live bun run dev`
 * silently run in fixture mode, which is the same class of bug — a wrong value where the reader
 * expects the one they typed.
 */
export const applyEnvFile = (
  loaded: Readonly<Record<string, string>>,
  env: Record<string, string | undefined>,
): void => {
  for (const [key, value] of Object.entries(loaded)) {
    // A variable already in the environment was set deliberately, on the command line or by the
    // shell, and outranks the file.
    env[key] ??= value
  }
}
