import { Effect, Schema } from 'effect'
import { ConfigError } from '../src/domain/errors'

/**
 * Configuration is read once, at startup, and a malformed value stops the
 * process with the variable named (R8.5). The alternative — a NaN timeout that
 * surfaces three layers down as a confusing fetch error — is exactly the kind
 * of debugging tax this project exists to avoid.
 */

export interface ServerConfig {
  readonly llmBaseUrl: string
  readonly llmApiKey: string | undefined
  readonly llmDefaultModel: string | undefined
  readonly llmTimeoutMs: number
  readonly port: number
  readonly traceDir: string
  readonly traceWriteEnabled: boolean
}

const DEFAULTS = {
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_TIMEOUT_MS: '120000',
  PORT: '8787',
  TRACE_DIR: '.traces',
  TRACE_WRITE_ENABLED: 'true',
} as const

const PositiveInt = Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

const decodePositiveInt = (
  variable: string,
  raw: string,
): Effect.Effect<number, ConfigError> =>
  Schema.decodeUnknown(PositiveInt)(raw).pipe(
    Effect.mapError(() => new ConfigError({ variable, value: raw, expected: 'a positive integer' })),
  )

const decodeUrl = (variable: string, raw: string): Effect.Effect<string, ConfigError> =>
  Effect.try({
    try: () => new URL(raw),
    catch: () => new ConfigError({ variable, value: raw, expected: 'an absolute http(s) URL' }),
  }).pipe(
    // `new URL("localhost:11434")` parses happily, with protocol "localhost:".
    // Without this check a missing scheme becomes a confusing fetch failure
    // much later, which is precisely the class of bug R8.5 exists to prevent.
    Effect.filterOrFail(
      (url) => url.protocol === 'http:' || url.protocol === 'https:',
      () => new ConfigError({ variable, value: raw, expected: 'an absolute http(s) URL' }),
    ),
    Effect.map((url) => url.toString().replace(/\/$/, '')),
  )

const decodeBoolean = (variable: string, raw: string): Effect.Effect<boolean, ConfigError> =>
  raw === 'true' || raw === 'false'
    ? Effect.succeed(raw === 'true')
    : Effect.fail(new ConfigError({ variable, value: raw, expected: '"true" or "false"' }))

const optional = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim() === '' ? undefined : raw

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<ServerConfig, ConfigError> =>
  Effect.gen(function* () {
    const llmBaseUrl = yield* decodeUrl('LLM_BASE_URL', env.LLM_BASE_URL ?? DEFAULTS.LLM_BASE_URL)
    const llmTimeoutMs = yield* decodePositiveInt(
      'LLM_TIMEOUT_MS',
      env.LLM_TIMEOUT_MS ?? DEFAULTS.LLM_TIMEOUT_MS,
    )
    const port = yield* decodePositiveInt('PORT', env.PORT ?? DEFAULTS.PORT)
    const traceWriteEnabled = yield* decodeBoolean(
      'TRACE_WRITE_ENABLED',
      env.TRACE_WRITE_ENABLED ?? DEFAULTS.TRACE_WRITE_ENABLED,
    )

    return {
      llmBaseUrl,
      llmApiKey: optional(env.LLM_API_KEY),
      llmDefaultModel: optional(env.LLM_DEFAULT_MODEL),
      llmTimeoutMs,
      port,
      traceDir: optional(env.TRACE_DIR) ?? DEFAULTS.TRACE_DIR,
      traceWriteEnabled,
    }
  })
