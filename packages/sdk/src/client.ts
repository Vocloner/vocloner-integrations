import { Assets } from './assets.js'
import { VoclonerError, positiveInteger, safeCode, validateId } from './errors.js'
import type { ErrorDetails } from './errors.js'
import { Deadline, Transport } from './transport.js'
import type { ClientOptions, RequestOptions, WriteOptions } from './transport.js'
import type {
  Capabilities,
  Generation,
  GenerationPage,
  Job,
  JobPage,
  SpeechRequest,
  Voice,
  VoicePage,
} from './generated/types.js'

export interface PageQuery {
  cursor?: string
  limit?: number
}
export interface VoiceQuery extends PageQuery {
  scope?: 'mine' | 'public' | 'all'
  search?: string
  language?: string
  category?: string
}
export interface WaitOptions extends RequestOptions {
  /** Fallback interval only. A Retry-After response always takes precedence. */
  pollInterval?: number
}
export interface SpeechOptions extends WriteOptions {
  /** Wait up to 20 seconds on the server. A 202 response is still possible. */
  wait?: 20
}

function requestOptions(options: RequestOptions = {}): RequestOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  }
}

function pageQuery(query: PageQuery = {}): Record<string, string | number | undefined> {
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)
  )
    throw new VoclonerError('invalid_options', 'limit must be an integer between one and fifty.')
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 500))
    throw new VoclonerError(
      'invalid_options',
      'cursor must be an opaque string of at most 500 characters.',
    )
  return { cursor: query.cursor, limit: query.limit }
}

function voiceQuery(query: VoiceQuery = {}): Record<string, string | number | undefined> {
  const result = pageQuery(query)
  if (query.scope !== undefined && !['mine', 'public', 'all'].includes(query.scope))
    throw new VoclonerError('invalid_options', 'scope must be mine, public or all.')
  result.scope = query.scope
  for (const key of ['search', 'language', 'category'] as const) {
    const value = query[key]
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length > (key === 'search' ? 80 : 40))
    )
      throw new VoclonerError('invalid_options', 'A voice filter is invalid or too long.')
    result[key] = value
  }
  return result
}

async function* iterate<T, Q extends PageQuery>(
  list: (query: Q, options: RequestOptions) => Promise<{ items: T[]; next_cursor: string | null }>,
  query: Q,
  options: RequestOptions,
): AsyncGenerator<T> {
  let current = query
  const cursors = new Set<string>()
  if (query.cursor !== undefined) cursors.add(query.cursor)
  while (true) {
    const page = await list(current, options)
    if (
      !Array.isArray(page.items) ||
      (page.next_cursor !== null && typeof page.next_cursor !== 'string')
    )
      throw new VoclonerError('invalid_response', 'The API returned an invalid page.')
    for (const item of page.items) yield item
    if (page.next_cursor === null) return
    if (cursors.has(page.next_cursor))
      throw new VoclonerError('invalid_response', 'The API repeated a pagination cursor.')
    cursors.add(page.next_cursor)
    current = { ...current, cursor: page.next_cursor }
  }
}

function checkedJob(job: Job, context: ErrorDetails = {}, expectedId?: string): Job {
  if (
    !job ||
    typeof job !== 'object' ||
    typeof job.id !== 'string' ||
    !['queued', 'running', 'reconciling', 'completed', 'failed', 'canceled'].includes(job.status)
  )
    throw new VoclonerError('invalid_response', 'The API returned an invalid job.', context)
  try {
    if (expectedId !== undefined && validateId(job.id) !== validateId(expectedId))
      throw new VoclonerError('invalid_response', 'The API returned a different job ID.', context)
    validateId(job.id)
  } catch {
    throw new VoclonerError(
      'invalid_response',
      'The API returned an invalid or different job ID.',
      context,
    )
  }
  return job
}

class Jobs {
  readonly #transport: Transport
  constructor(transport: Transport) {
    this.#transport = transport
  }

  list(query: PageQuery = {}, options: RequestOptions = {}): Promise<JobPage> {
    return this.#transport.json('jobs', { ...requestOptions(options), query: pageQuery(query) })
  }
  async get(id: string, options: RequestOptions = {}): Promise<Job> {
    const normalized = validateId(id)
    try {
      const job = await this.#transport.json<Job>(`jobs/${normalized}`, requestOptions(options))
      return checkedJob(job, { ...this.#transport.metadata(job), jobId: normalized }, normalized)
    } catch (error) {
      if (error instanceof VoclonerError) throw error.withContext({ jobId: normalized })
      throw new VoclonerError('invalid_response', 'The job could not be inspected.', {
        jobId: normalized,
      })
    }
  }
  async cancel(id: string, options: WriteOptions): Promise<Job> {
    const normalized = validateId(id)
    try {
      const job = await this.#transport.json<Job>(`jobs/${normalized}/cancel`, {
        ...requestOptions(options),
        method: 'POST',
        ...(options?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
      })
      return checkedJob(job, { ...this.#transport.metadata(job), jobId: normalized }, normalized)
    } catch (error) {
      const context = {
        jobId: normalized,
        ...(options?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
      }
      if (error instanceof VoclonerError) throw error.withContext(context)
      throw new VoclonerError(
        'invalid_response',
        'The cancellation could not be inspected.',
        context,
      )
    }
  }
  iterate(query: PageQuery = {}, options: RequestOptions = {}): AsyncGenerator<Job> {
    return iterate((q, o) => this.list(q, o), query, options)
  }

  async wait(input: string | Job, options: WaitOptions = {}): Promise<Job> {
    let current = typeof input === 'string' ? undefined : checkedJob(input)
    const id = validateId(typeof input === 'string' ? input : input.id)
    const interval = positiveInteger(options.pollInterval ?? 3000, 'pollInterval')
    const deadline = new Deadline(options.timeout ?? 180_000, options.signal)
    const originalKey = current ? this.#transport.metadata(current).idempotencyKey : undefined
    try {
      while (true) {
        if (deadline.signal.aborted) throw deadline.error()
        if (!current)
          current = await this.get(id, {
            signal: deadline.signal,
            timeout: Math.max(1, deadline.expires - Date.now()),
          })
        if (current.status === 'completed') return current
        if (current.status === 'failed' || current.status === 'canceled')
          throw new VoclonerError(
            current.status === 'canceled'
              ? 'job_canceled'
              : safeCode(current.error?.code, 'job_failed'),
            current.status === 'canceled'
              ? 'The remote job was canceled. Inspect its final usage.'
              : 'The remote job failed. Inspect its final usage before starting new work.',
            { jobId: id, job: current, ...this.#transport.metadata(current) },
          )
        const metadata = this.#transport.metadata(current)
        const delay = metadata.retryAfter ?? interval
        if (Date.now() + delay >= deadline.expires)
          throw new VoclonerError(
            'polling_timeout',
            'The next poll exceeds the local deadline. Resume this job by ID.',
            { retryable: true, ...metadata },
          )
        await deadline.sleep(delay)
        current = await this.get(id, {
          signal: deadline.signal,
          timeout: Math.max(1, deadline.expires - Date.now()),
        })
      }
    } catch (error) {
      const safe = deadline.signal.aborted
        ? deadline.error()
        : error instanceof VoclonerError
          ? error
          : new VoclonerError('invalid_response', 'The job could not be inspected.')
      throw safe.withContext({
        jobId: id,
        ...(current === undefined ? {} : { job: current }),
        ...(originalKey === undefined ? {} : { idempotencyKey: originalKey }),
      })
    } finally {
      deadline.dispose()
    }
  }
}

/** Server-side REST client. All paid writes require the caller's stable key. */
export class Vocloner {
  readonly voices: {
    list: (query?: VoiceQuery, options?: RequestOptions) => Promise<VoicePage>
    get: (id: string, options?: RequestOptions) => Promise<Voice>
    iterate: (query?: VoiceQuery, options?: RequestOptions) => AsyncGenerator<Voice>
  }
  readonly speech: { create: (input: SpeechRequest, options: SpeechOptions) => Promise<Job> }
  readonly jobs: Jobs
  readonly generations: {
    list: (query?: PageQuery, options?: RequestOptions) => Promise<GenerationPage>
    get: (id: string, options?: RequestOptions) => Promise<Generation>
    iterate: (query?: PageQuery, options?: RequestOptions) => AsyncGenerator<Generation>
  }
  readonly assets: Assets
  readonly capabilities: { get: (options?: RequestOptions) => Promise<Capabilities> }

  constructor(options: ClientOptions) {
    const transport = new Transport(options)
    this.voices = {
      list: (query = {}, opts = {}) =>
        transport.json('voices', { ...requestOptions(opts), query: voiceQuery(query) }),
      get: (id, opts = {}) => transport.json(`voices/${validateId(id)}`, requestOptions(opts)),
      iterate: (query = {}, opts = {}) => iterate((q, o) => this.voices.list(q, o), query, opts),
    }
    this.speech = {
      create: async (input, opts) => {
        if (!input || typeof input !== 'object')
          throw new VoclonerError('invalid_options', 'A speech input is required.')
        validateId(input.voice_id)
        if (
          typeof input.text !== 'string' ||
          !input.text.trim() ||
          input.text.length > 12000 ||
          (input.format !== undefined && !['mp3', 'wav'].includes(input.format)) ||
          Object.keys(input).some((key) => !['voice_id', 'text', 'format'].includes(key))
        )
          throw new VoclonerError(
            'invalid_options',
            'Speech input must contain a voice_id, text (1–12000 characters), and optional mp3/wav format.',
          )
        const job = await transport.json<Job>('speech', {
          ...requestOptions(opts),
          method: 'POST',
          body: input,
          ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
          ...(opts?.wait === undefined ? {} : { wait: opts.wait }),
        })
        return checkedJob(job, transport.metadata(job))
      },
    }
    this.jobs = new Jobs(transport)
    this.generations = {
      list: (query = {}, opts = {}) =>
        transport.json('generations', { ...requestOptions(opts), query: pageQuery(query) }),
      get: (id, opts = {}) => transport.json(`generations/${validateId(id)}`, requestOptions(opts)),
      iterate: (query = {}, opts = {}) =>
        iterate((q, o) => this.generations.list(q, o), query, opts),
    }
    this.assets = new Assets(transport)
    this.capabilities = { get: (opts = {}) => transport.json('capabilities', requestOptions(opts)) }
  }
}
