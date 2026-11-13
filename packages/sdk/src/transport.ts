import { VoclonerError, positiveInteger, safeCode } from './errors.js'

export interface RequestOptions {
  signal?: AbortSignal
  /** Total request deadline, including retries and response body, in milliseconds. */
  timeout?: number
}

export interface WriteOptions extends RequestOptions {
  idempotencyKey: string
}

export interface ClientOptions {
  apiKey: string
  baseURL?: string
  timeout?: number
  maxRetries?: number
  fetch?: typeof globalThis.fetch
}

export interface Metadata {
  requestId?: string
  retryAfter?: number
  jobId?: string
  idempotencyKey?: string
}

interface HttpOptions extends RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  idempotencyKey?: string
  query?: Record<string, string | number | undefined>
  wait?: 20
}

/** Parses Retry-After without capping a server's requested delay. */
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000)
    return Number.isFinite(ms) ? ms : undefined
  }
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export class Deadline {
  readonly controller = new AbortController()
  readonly expires: number
  readonly #parent: AbortSignal | undefined
  readonly #timer: ReturnType<typeof setTimeout>
  #expired = false
  readonly #onAbort = () => this.controller.abort()

  constructor(timeout: number, signal?: AbortSignal) {
    positiveInteger(timeout, 'timeout')
    this.expires = Date.now() + timeout
    this.#parent = signal
    this.#timer = setTimeout(() => {
      this.#expired = true
      this.controller.abort()
    }, timeout)
    if (signal?.aborted) this.controller.abort()
    else signal?.addEventListener('abort', this.#onAbort, { once: true })
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  error(): VoclonerError {
    return new VoclonerError(
      this.#expired ? 'timeout' : 'aborted',
      this.#expired
        ? 'The local deadline elapsed. Resume the existing operation; do not submit another generation.'
        : 'The local request was aborted. Remote work may still be running.',
      { retryable: this.#expired },
    )
  }

  async run<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      // Observe a promise that may already be rejected without exposing its cause.
      void promise.catch(() => {})
      throw this.error()
    }
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(this.error())
          this.signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      if (abort) this.signal.removeEventListener('abort', abort)
    }
  }

  async sleep(ms: number): Promise<void> {
    if (this.signal.aborted) throw this.error()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.run(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms)
        }),
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  dispose(): void {
    clearTimeout(this.#timer)
    this.#parent?.removeEventListener('abort', this.#onAbort)
  }
}

export interface OpenResponse {
  response: Response
  deadline: Deadline
  metadata: Metadata
}

const transientStatuses = new Set([429, 502, 503, 504])
const maxJsonBytes = 2 * 1024 * 1024

function requestId(response: Response): string | undefined {
  const value = response.headers.get('x-request-id')
  return value && /^[\w-]{1,128}$/.test(value) ? value : undefined
}

async function readBody(response: Response, deadline: Deadline): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await deadline.run(reader.read())
      if (done) break
      size += value.byteLength
      if (size > maxJsonBytes)
        throw new VoclonerError('invalid_response', 'The JSON response exceeds the size limit.')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class Transport {
  readonly #apiKey: string
  readonly #base: URL
  readonly #fetch: typeof globalThis.fetch
  readonly timeout: number
  readonly #maxRetries: number
  readonly #metadata = new WeakMap<object, Metadata>()

  constructor(options: ClientOptions) {
    if (
      !options ||
      typeof options.apiKey !== 'string' ||
      !options.apiKey.trim() ||
      /\s/.test(options.apiKey)
    )
      throw new VoclonerError(
        'invalid_options',
        'A nonempty REST API key without whitespace is required.',
      )
    if (/^vcl_(?:key|access|refresh)_/.test(options.apiKey))
      throw new VoclonerError(
        'invalid_options',
        'Use a REST API key for the REST SDK. MCP credentials are separate.',
      )
    let base: URL
    try {
      base = new URL(options.baseURL ?? 'https://api.vocloner.org/v1')
    } catch {
      throw new VoclonerError('invalid_options', 'The base URL is invalid.')
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    if (
      (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname.replace(/\/$/, '') !== '/v1'
    )
      throw new VoclonerError(
        'invalid_options',
        'The base URL must be an HTTPS API origin ending in /v1 (or HTTP loopback).',
      )
    base.pathname = '/v1/'
    this.#base = base
    this.#apiKey = options.apiKey
    this.timeout = positiveInteger(options.timeout ?? 30_000, 'timeout')
    const retries = options.maxRetries ?? 3
    if (!Number.isInteger(retries) || retries < 0 || retries > 3)
      throw new VoclonerError(
        'invalid_options',
        'maxRetries must be an integer between zero and three.',
      )
    this.#maxRetries = retries
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  metadata(value: object): Metadata {
    return this.#metadata.get(value) ?? {}
  }

  async json<T>(path: string, options: HttpOptions = {}): Promise<T> {
    const opened = await this.open(path, options)
    try {
      const value = await readBody(opened.response, opened.deadline)
      if (typeof value !== 'object' || value === null)
        throw new VoclonerError('invalid_response', 'The API returned an invalid JSON resource.')
      this.#metadata.set(value, this.context(options, opened.metadata))
      return value as T
    } catch (error) {
      if (opened.deadline.signal.aborted)
        throw opened.deadline.error().withContext(this.context(options, opened.metadata))
      const safe =
        error instanceof VoclonerError
          ? error
          : new VoclonerError('invalid_response', 'The API returned invalid or incomplete JSON.')
      throw safe.withContext(this.context(options, opened.metadata))
    } finally {
      opened.deadline.dispose()
    }
  }

  private context(options: HttpOptions, metadata: Metadata) {
    return {
      ...metadata,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    }
  }

  async open(path: string, options: HttpOptions = {}): Promise<OpenResponse> {
    const url = new URL(path, this.#base)
    if (
      url.origin !== this.#base.origin ||
      !url.pathname.startsWith('/v1/') ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new VoclonerError('invalid_options', 'Unexpected API resource URL.')
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const method = options.method ?? 'GET'
    if (
      method === 'POST' &&
      (typeof options.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey))
    )
      throw new VoclonerError('invalid_options', 'Provide a stable idempotencyKey for every write.')
    if (options.wait !== undefined && options.wait !== 20)
      throw new VoclonerError('invalid_options', 'The supported server wait is 20 seconds.')
    let serialized: string | undefined
    try {
      serialized = options.body === undefined ? undefined : JSON.stringify(options.body)
    } catch {
      throw new VoclonerError('invalid_options', 'The request body must be serializable JSON.')
    }
    const deadline = new Deadline(options.timeout ?? this.timeout, options.signal)
    let metadata: Metadata = {}
    try {
      for (let attempt = 0; ; attempt++) {
        if (deadline.signal.aborted) throw deadline.error()
        let response: Response
        try {
          response = await deadline.run(
            this.#fetch(url, {
              method,
              signal: deadline.signal,
              redirect: 'error',
              headers: {
                Authorization: `Bearer ${this.#apiKey}`,
                Accept: path.startsWith('assets/') ? 'audio/*' : 'application/json',
                ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(options.idempotencyKey === undefined
                  ? {}
                  : { 'Idempotency-Key': options.idempotencyKey }),
                ...(options.wait === undefined ? {} : { Prefer: 'wait=20' }),
              },
              ...(serialized === undefined ? {} : { body: serialized }),
            }),
          )
        } catch {
          if (deadline.signal.aborted) throw deadline.error()
          if (attempt >= this.#maxRetries)
            throw new VoclonerError(
              'network_error',
              'The request could not be confirmed. Reuse its idempotency key when resuming.',
              { retryable: true },
            )
          await this.pause(deadline, undefined, attempt)
          continue
        }
        const id = requestId(response)
        const retry = retryAfter(response.headers.get('retry-after'))
        const jobId = response.headers.get('x-job-id')
        metadata = {
          ...(id === undefined ? {} : { requestId: id }),
          ...(retry === undefined ? {} : { retryAfter: retry }),
          ...(jobId && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(jobId)
            ? { jobId }
            : {}),
        }
        if (response.ok) return { response, deadline, metadata }
        let body: unknown
        try {
          body = await readBody(response, deadline)
        } catch {
          if (deadline.signal.aborted) throw deadline.error()
        }
        const detail =
          typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined
        const code = safeCode(
          typeof detail === 'object' && detail !== null && 'code' in detail
            ? detail.code
            : undefined,
        )
        const canRetry =
          transientStatuses.has(response.status) ||
          (response.status === 409 && code === 'operation_pending')
        const error = new VoclonerError(code, `The API request failed (HTTP ${response.status}).`, {
          status: response.status,
          ...metadata,
          retryable: canRetry,
        })
        if (!canRetry || attempt >= this.#maxRetries) throw error
        await this.pause(deadline, retry, attempt, error)
      }
    } catch (error) {
      deadline.dispose()
      const safe = deadline.signal.aborted
        ? deadline.error()
        : error instanceof VoclonerError
          ? error
          : new VoclonerError('network_error', 'The request could not be confirmed.', {
              retryable: true,
            })
      throw safe.withContext(this.context(options, metadata))
    }
  }

  private async pause(
    deadline: Deadline,
    requested: number | undefined,
    attempt: number,
    error?: VoclonerError,
  ) {
    const delay = requested ?? Math.round(1000 * 2 ** attempt * (0.75 + Math.random() * 0.5))
    if (Date.now() + delay >= deadline.expires)
      throw (
        error ??
        new VoclonerError(
          'retry_later',
          'The next retry exceeds the local deadline. Resume with the same idempotency key.',
          { retryable: true, retryAfter: delay },
        )
      )
    await deadline.sleep(delay)
  }
}
