/**
 * The Copernicus data store's retrieval API, which is a job queue rather than a request.
 *
 * Every other upstream in this repository answers the question you asked, in the call you asked
 * it. This one does not: a retrieval is submitted, queued behind everyone else's, run, and left as
 * a file to collect. Minutes is normal and hours is possible. Nothing in a request path can wait
 * for that, so this module deliberately exposes the three steps separately — submit, poll,
 * download — and never loops. Deciding how long to wait belongs to the caller, and in this server
 * the answer is "not at all": see `glofas.ts`.
 *
 * The API is OGC API — Processes:
 *
 *   POST {api}/retrieve/v1/processes/{dataset}/execution  -> { jobID, status }
 *   GET  {api}/retrieve/v1/jobs/{jobID}                   -> { status }
 *   GET  {api}/retrieve/v1/jobs/{jobID}/results           -> { asset: { value: { href } } }
 *
 * Authentication is a `PRIVATE-TOKEN` header. It is a header rather than a query parameter on
 * purpose: `redactUrl` can only mask a key it can see in a URL, and a token in a header never
 * reaches a log or a trace in the first place.
 */
import type { GeoProxyService } from '../geo-proxy'
import type { CemsCredentials } from './credentials'

/**
 * The store's own job states.
 *
 * `rejected` is the one that is easy to miss and expensive to mishandle: a job can be accepted at
 * submission and then refused during execution, most often because the per-dataset queue is full.
 * Treating an unrecognised status as "finished" and asking for its results turns that into a
 * confusing 400 from the results endpoint instead of a job to submit again.
 */
export type JobStatus = 'accepted' | 'running' | 'successful' | 'failed' | 'dismissed' | 'rejected'

export interface SubmittedJob {
  readonly jobId: string
  readonly status: JobStatus
}

export interface JobResult {
  readonly href: string
  readonly bytes?: number
  readonly contentType?: string
}

/**
 * A refusal the caller can act on, as opposed to an outage it can only retry.
 *
 * The licence case is the one worth separating: it is not a failure of the store, it is a consent
 * the account holder has not given yet, and it is fixed in a browser rather than by waiting. It
 * arrives as a 403 that would otherwise be reported as "upstream unavailable", sending the reader
 * to look at the network.
 */
export class CemsRequestError extends Error {
  readonly status: number
  readonly kind: 'licence' | 'auth' | 'request' | 'upstream'

  constructor(message: string, status: number, kind: CemsRequestError['kind']) {
    super(message)
    this.name = 'CemsRequestError'
    this.status = status
    this.kind = kind
  }
}

interface StoreErrorBody {
  readonly title?: string
  readonly detail?: string
  readonly message?: string
}

const describeStoreError = (status: number, body: string): CemsRequestError => {
  let parsed: StoreErrorBody = {}
  try {
    parsed = JSON.parse(body) as StoreErrorBody
  } catch {
    // A non-JSON body is usually an HTML gateway page; the status carries the meaning.
  }
  const detail = parsed.detail ?? parsed.message ?? parsed.title ?? body.slice(0, 300)

  if (status === 403 && /licence|policies|terms/i.test(detail)) {
    return new CemsRequestError(
      `The Copernicus account has not accepted the licences this dataset requires. Accept them ` +
        `once, in a browser, and no code change is needed: ${detail}`,
      status,
      'licence',
    )
  }
  /**
   * The store answers "your request is too large" with a 403, which is not a word about the token.
   * Classifying it by status alone reported a selection that needed splitting as a bad key and
   * sent the reader to check `CEMS_API_KEY` — so the body decides here, not the status.
   */
  if (/too large|reduce your selection|exceed/i.test(detail)) {
    return new CemsRequestError(
      `The store refused the retrieval as too large: ${detail} Reduce what one job asks for — ` +
        `THRESHOLD_YEARS_PER_CHUNK in glofas-request.ts is the knob for the historical retrievals.`,
      status,
      'request',
    )
  }
  if (status === 401 || status === 403) {
    return new CemsRequestError(
      `The Copernicus data store rejected the token (HTTP ${status}): ${detail}. Check CEMS_API_KEY ` +
        `or the \`key:\` line it was read from.`,
      status,
      'auth',
    )
  }
  if (status >= 400 && status < 500) {
    return new CemsRequestError(`The store rejected the request (HTTP ${status}): ${detail}`, status, 'request')
  }
  return new CemsRequestError(`The store failed (HTTP ${status}): ${detail}`, status, 'upstream')
}

export const CEMS_SOURCE_ID = 'eu.copernicus.cems-flood'

/** Generous next to the 8 s a hazard tile gets: this is a control-plane call to a busy queue. */
const CONTROL_TIMEOUT_MS = 30_000

export interface StoreClientOptions {
  /** Cap on a downloaded retrieval. A multi-decade discharge series for one box is ~20 MB. */
  readonly maxDownloadBytes?: number
  readonly downloadTimeoutMs?: number
}

export class CemsStoreClient {
  private readonly proxy: GeoProxyService
  private readonly credentials: CemsCredentials
  private readonly options: StoreClientOptions

  constructor(proxy: GeoProxyService, credentials: CemsCredentials, options: StoreClientOptions = {}) {
    this.proxy = proxy
    this.credentials = credentials
    this.options = options
  }

  private get authHeaders(): Record<string, string> {
    return { 'PRIVATE-TOKEN': this.credentials.key, 'Content-Type': 'application/json' }
  }

  /** Queues a retrieval. Returns as soon as the store has accepted it, which is immediately. */
  async submit(dataset: string, inputs: Record<string, unknown>): Promise<SubmittedJob> {
    const url = `${this.credentials.apiUrl}/retrieve/v1/processes/${dataset}/execution`
    const res = await this.proxy.fetchUpstream(CEMS_SOURCE_ID, url, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({ inputs }),
      timeoutMs: CONTROL_TIMEOUT_MS,
    })
    if (res.status < 200 || res.status >= 300) throw describeStoreError(res.status, res.body)

    const parsed = JSON.parse(res.body) as { jobID?: string; status?: JobStatus }
    if (typeof parsed.jobID !== 'string') {
      throw new CemsRequestError(
        `The store accepted the retrieval but named no job: ${res.body.slice(0, 300)}`,
        res.status,
        'upstream',
      )
    }
    return { jobId: parsed.jobID, status: parsed.status ?? 'accepted' }
  }

  async status(jobId: string): Promise<JobStatus> {
    const url = `${this.credentials.apiUrl}/retrieve/v1/jobs/${jobId}`
    const res = await this.proxy.fetchUpstream(CEMS_SOURCE_ID, url, {
      headers: this.authHeaders,
      timeoutMs: CONTROL_TIMEOUT_MS,
    })
    // A job the store has forgotten is not an outage; it is a job to submit again.
    if (res.status === 404) return 'dismissed'
    if (res.status < 200 || res.status >= 300) throw describeStoreError(res.status, res.body)

    const parsed = JSON.parse(res.body) as { status?: JobStatus }
    return parsed.status ?? 'accepted'
  }

  /** Where a finished job left its file. The href is pre-signed and short-lived — collect it now. */
  async result(jobId: string): Promise<JobResult> {
    const url = `${this.credentials.apiUrl}/retrieve/v1/jobs/${jobId}/results`
    const res = await this.proxy.fetchUpstream(CEMS_SOURCE_ID, url, {
      headers: this.authHeaders,
      timeoutMs: CONTROL_TIMEOUT_MS,
    })
    if (res.status < 200 || res.status >= 300) throw describeStoreError(res.status, res.body)

    const parsed = JSON.parse(res.body) as {
      asset?: { value?: { href?: string; 'file:size'?: number; type?: string } }
    }
    const value = parsed.asset?.value
    if (typeof value?.href !== 'string') {
      throw new CemsRequestError(
        `A finished job produced no downloadable asset: ${res.body.slice(0, 300)}`,
        res.status,
        'upstream',
      )
    }
    return { href: value.href, bytes: value['file:size'], contentType: value.type }
  }

  /**
   * Collects the file. Binary, because it is NetCDF — reading it as text would decode it as UTF-8
   * and destroy every byte above 0x7f, which is most of them.
   */
  async download(href: string): Promise<Uint8Array> {
    const res = await this.proxy.fetchUpstreamBinary(CEMS_SOURCE_ID, href, {
      headers: { 'PRIVATE-TOKEN': this.credentials.key },
      maxBytes: this.options.maxDownloadBytes ?? 64 * 1024 * 1024,
      timeoutMs: this.options.downloadTimeoutMs ?? 120_000,
    })
    if (res.status < 200 || res.status >= 300) {
      throw describeStoreError(res.status, new TextDecoder().decode(res.bytes.subarray(0, 500)))
    }
    return res.bytes
  }
}
