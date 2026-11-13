import type { Job } from './generated/types.js'

export interface ErrorDetails {
  status?: number
  requestId?: string
  retryable?: boolean
  retryAfter?: number
  idempotencyKey?: string
  jobId?: string
  job?: Job
}

/** Safe diagnostic metadata. Request bodies, URLs and credentials are never attached. */
export class VoclonerError extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly requestId: string | undefined
  readonly retryable: boolean
  /** Milliseconds requested by Retry-After. */
  readonly retryAfter: number | undefined
  readonly idempotencyKey: string | undefined
  readonly jobId: string | undefined
  readonly job: Job | undefined

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message)
    this.name = 'VoclonerError'
    this.code = code
    this.status = details.status
    this.requestId = details.requestId
    this.retryable = details.retryable ?? false
    this.retryAfter = details.retryAfter
    this.idempotencyKey = details.idempotencyKey
    this.jobId = details.jobId
    this.job = details.job
  }

  withContext(details: ErrorDetails): VoclonerError {
    return new VoclonerError(this.code, this.message, {
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      retryable: this.retryable,
      ...(this.retryAfter === undefined ? {} : { retryAfter: this.retryAfter }),
      ...(this.idempotencyKey === undefined ? {} : { idempotencyKey: this.idempotencyKey }),
      ...(this.jobId === undefined ? {} : { jobId: this.jobId }),
      ...(this.job === undefined ? {} : { job: this.job }),
      ...details,
    })
  }
}

export function safeCode(value: unknown, fallback = 'http_error'): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value : fallback
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new VoclonerError(
      'invalid_options',
      `${name} must be a positive integer up to 2147483647.`,
    )
  return value
}

export function validateId(id: string): string {
  if (
    typeof id !== 'string' ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)
  )
    throw new VoclonerError('invalid_id', 'A Vocloner UUID is required.')
  return id.toLowerCase()
}
