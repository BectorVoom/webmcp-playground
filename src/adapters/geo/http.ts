import { Effect, Schema } from 'effect'
import {
  SourceRateLimited,
  SourceUnavailable,
  UpstreamPayloadInvalid,
  type GeoError,
} from '../../domain/geo-errors'

export interface ProxiedFetchOptions {
  readonly method?: 'GET' | 'POST'
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly sourceId: string
  readonly upstreamUrl: string
}

export interface ProxiedFetchResult<T> {
  readonly data: T
  readonly rawText: string
  readonly status: number
  readonly cacheHit: boolean
  readonly cacheAgeMs: number
}

const MAX_RAW_BODY_TRUNCATE = 4096

export const truncateBody = (body: string, maxLen = MAX_RAW_BODY_TRUNCATE): string => {
  if (body.length <= maxLen) return body
  return `${body.slice(0, maxLen)}\n...[TRUNCATED ${body.length - maxLen} bytes]...`
}

export const fetchAndDecode = <A, I = A>(
  url: string,
  options: ProxiedFetchOptions,
  schema: Schema.Schema<A, I, never>,
): Effect.Effect<ProxiedFetchResult<A>, GeoError, never> =>
  Effect.gen(function* () {
    const { sourceId, method = 'GET', headers = {}, body, signal } = options

    const response = yield* Effect.tryPromise({
      try: async () => {
        const fetchHeaders: Record<string, string> = {
          'content-type': 'application/json',
          ...headers,
        }
        return await fetch(url, {
          method,
          headers: fetchHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal,
        })
      },
      catch: (err) =>
        new SourceUnavailable({
          sourceId,
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    })

    const rawText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (err) =>
        new SourceUnavailable({
          sourceId,
          message: `Failed to read response body: ${String(err)}`,
          cause: err,
        }),
    })

    if (!response.ok) {
      if (response.status === 429) {
        const resetHeader = response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset')
        const resetAt = resetHeader ? Number(resetHeader) * 1000 + Date.now() : undefined
        return yield* Effect.fail(new SourceRateLimited({ sourceId, resetAt }))
      }
      return yield* Effect.fail(
        new SourceUnavailable({
          sourceId,
          message: `HTTP ${response.status} ${response.statusText}: ${truncateBody(rawText, 500)}`,
        }),
      )
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawText)
    } catch {
      return yield* Effect.fail(
        new UpstreamPayloadInvalid({
          sourceId,
          path: '(root JSON parse)',
          expected: 'valid JSON',
          excerpt: truncateBody(rawText, 200),
        }),
      )
    }

    const decoded = yield* Schema.decodeUnknown(schema)(parsedJson).pipe(
      Effect.mapError((schemaErr) => {
        const message = String(schemaErr)
        return new UpstreamPayloadInvalid({
          sourceId,
          path: message,
          expected: 'Schema conformance',
          excerpt: truncateBody(rawText, 200),
        })
      }),
    )

    const cacheHitHeader = response.headers.get('x-cache-hit') === 'true'
    const cacheAgeHeader = Number(response.headers.get('x-cache-age-ms') ?? '0')

    return {
      data: decoded,
      rawText,
      status: response.status,
      cacheHit: cacheHitHeader,
      cacheAgeMs: cacheAgeHeader,
    }
  })
