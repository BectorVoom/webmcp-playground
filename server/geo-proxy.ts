import type { ServerConfig } from './config'
import { isHostAllowed } from './config'

export interface CacheEntry<T = unknown> {
  readonly data: T
  readonly rawText: string
  readonly status: number
  readonly contentType: string
  readonly cachedAt: number
}

export interface CircuitState {
  readonly failures: number
  readonly state: 'closed' | 'open'
  readonly openUntil?: number
}

export interface GeoProxyStats {
  readonly cacheEntries: number
  readonly circuitStates: Record<string, 'closed' | 'open'>
}

export class GeoProxyService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly circuits = new Map<string, CircuitState>()
  private readonly config: ServerConfig

  constructor(config: ServerConfig) {
    this.config = config
  }

  redactUrl(urlStr: string): string {
    return urlStr.replace(
      /([?&](?:key|api_key|apikey|token|access_token|app_id)=)([^&]+)/gi,
      '$1[REDACTED]',
    )
  }

  getTtlForSource(sourceId: string): number {
    if (sourceId.includes('alert')) return this.config.geoCacheTtlAlertsMs
    if (sourceId.includes('flood')) return this.config.geoCacheTtlFloodMs
    if (sourceId.includes('place') || sourceId.includes('shelter'))
      return this.config.geoCacheTtlPlacesMs
    if (sourceId.includes('tile')) return this.config.geoCacheTtlTilesMs
    return 60_000
  }

  getCircuit(sourceId: string): CircuitState {
    const current = this.circuits.get(sourceId)
    if (!current) return { failures: 0, state: 'closed' }
    if (current.state === 'open' && current.openUntil && Date.now() > current.openUntil) {
      // Cooldown expired -> half-open / reset
      const reset: CircuitState = { failures: 0, state: 'closed' }
      this.circuits.set(sourceId, reset)
      return reset
    }
    return current
  }

  recordSuccess(sourceId: string): void {
    this.circuits.set(sourceId, { failures: 0, state: 'closed' })
  }

  recordFailure(sourceId: string): void {
    const current = this.getCircuit(sourceId)
    const failures = current.failures + 1
    if (failures >= this.config.geoBreakerThreshold) {
      this.circuits.set(sourceId, {
        failures,
        state: 'open',
        openUntil: Date.now() + this.config.geoBreakerCooldownMs,
      })
    } else {
      this.circuits.set(sourceId, { failures, state: 'closed' })
    }
  }

  getStats(): GeoProxyStats {
    const circuitStates: Record<string, 'closed' | 'open'> = {}
    for (const [sourceId] of this.circuits.entries()) {
      circuitStates[sourceId] = this.getCircuit(sourceId).state
    }
    return {
      cacheEntries: this.cache.size,
      circuitStates,
    }
  }

  getCache<T>(
    cacheKey: string,
    ttlMs: number,
  ): { entry: CacheEntry<T>; hit: boolean; ageMs: number } | null {
    const entry = this.cache.get(cacheKey)
    if (!entry) return null
    const ageMs = Date.now() - entry.cachedAt
    if (ageMs > ttlMs) {
      this.cache.delete(cacheKey)
      return null
    }
    return { entry: entry as CacheEntry<T>, hit: true, ageMs }
  }

  setCache<T>(
    cacheKey: string,
    data: T,
    rawText: string,
    status: number,
    contentType: string,
  ): void {
    this.cache.set(cacheKey, {
      data,
      rawText,
      status,
      contentType,
      cachedAt: Date.now(),
    })
  }

  clearCache(): void {
    this.cache.clear()
  }

  async fetchUpstream(
    sourceId: string,
    targetUrl: string,
    options: {
      method?: 'GET' | 'POST'
      headers?: Record<string, string>
      body?: string
      maxBytes?: number
      retries?: number
    } = {},
  ): Promise<{
    status: number
    body: string
    contentType: string
    redactedUrl: string
  }> {
    const redactedUrl = this.redactUrl(targetUrl)

    // 1. Allowlist enforcement (R7.8)
    if (!isHostAllowed(this.config.geoAllowedHosts, targetUrl)) {
      const hostname = new URL(targetUrl).hostname
      throw new Error(`HostNotAllowed: ${hostname}`)
    }

    // 2. Circuit breaker check (R7.6)
    const circuit = this.getCircuit(sourceId)
    if (circuit.state === 'open') {
      throw new Error(`SourceCircuitOpen: ${sourceId}`)
    }

    const method = options.method ?? 'GET'
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024 // 5MB cap (R7.10)
    const maxRetries = method === 'GET' ? (options.retries ?? 2) : 0 // Idempotent GETs only (R7.5)

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.config.geoTimeoutMs)

        const res = await fetch(targetUrl, {
          method,
          headers: {
            'User-Agent': 'webmcp-playground/0.1.0 (safety-support)',
            Accept: 'application/json, text/plain, */*',
            ...options.headers,
          },
          body: options.body,
          signal: controller.signal,
        })
        clearTimeout(timeout)

        // Read body with byte cap enforcement (R7.10)
        const reader = res.body?.getReader()
        let bodyText = ''
        let receivedBytes = 0

        if (reader) {
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            receivedBytes += value.length
            if (receivedBytes > maxBytes) {
              reader.cancel()
              throw new Error(`UpstreamTooLarge: ${receivedBytes} exceeded cap ${maxBytes}`)
            }
            bodyText += decoder.decode(value, { stream: true })
          }
          bodyText += decoder.decode()
        } else {
          bodyText = await res.text()
        }

        if (res.status >= 500 && attempt < maxRetries) {
          // Retry on 5xx with exponential backoff (R7.5)
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
          continue
        }

        if (res.ok) {
          this.recordSuccess(sourceId)
        } else if (res.status >= 500) {
          this.recordFailure(sourceId)
        }

        return {
          status: res.status,
          body: bodyText,
          contentType: res.headers.get('content-type') ?? 'application/json',
          redactedUrl,
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (lastError.message.includes('HostNotAllowed') || lastError.message.includes('UpstreamTooLarge')) {
          throw lastError
        }
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
        }
      }
    }

    this.recordFailure(sourceId)
    throw lastError ?? new Error(`Failed to fetch upstream ${redactedUrl}`)
  }
}
