import { createHmac, timingSafeEqual } from 'node:crypto'

export interface WebhookVerificationOptions {
  /** Current Unix time in seconds. Defaults to Date.now() / 1000. */
  nowSeconds?: number
  /** Maximum clock difference in seconds, from 0 to 300. Defaults to 300. */
  toleranceSeconds?: number
}

export interface WebhookHeaders {
  signature: string
  eventId: string
}

export type JobEvent = {
  id: string
  created_at: string
} & (
  | { type: 'job.completed'; data: { job_id: string; status: 'completed' } }
  | { type: 'job.failed'; data: { job_id: string; status: 'failed' } }
)

export class WebhookError extends Error {
  readonly code: 'invalid_signature' | 'invalid_payload'

  constructor(code: 'invalid_signature' | 'invalid_payload') {
    super(code === 'invalid_signature' ? 'Invalid webhook signature.' : 'Invalid webhook event.')
    this.name = 'WebhookError'
    this.code = code
  }
}

/** Verify the exact received bytes before parsing JSON. Does not prevent duplicate delivery. */
export function verifyWebhook(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
  options: WebhookVerificationOptions = {},
): boolean {
  const now = options.nowSeconds ?? Date.now() / 1000
  const tolerance = options.toleranceSeconds ?? 300
  if (
    !(rawBody instanceof Uint8Array) ||
    typeof signature !== 'string' ||
    typeof secret !== 'string' ||
    !secret ||
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 300
  ) {
    return false
  }
  const match = /^t=(0|[1-9]\d{0,11}),v1=([a-f0-9]{64})$/.exec(signature)
  if (!match?.[1] || !match[2] || match[0] !== signature) return false
  const timestamp = Number(match[1])
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) return false
  const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(rawBody).digest()
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'))
}

const uuid =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i
// The transport uses RFC 3339 timestamps. Keep their original string representation.
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = timestampPattern.exec(value)
  if (!match || match[0] !== value || !Number.isFinite(Date.parse(value))) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Authenticate and validate a job notification. Persist event.id under a UNIQUE constraint
 * in the same transaction as your work before acknowledging delivery. Fetch the job through
 * the authenticated API to retrieve its result.
 */
export function parseWebhook(
  rawBody: Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  options: WebhookVerificationOptions = {},
): JobEvent {
  if (!headers || !verifyWebhook(rawBody, headers.signature, secret, options)) {
    throw new WebhookError('invalid_signature')
  }
  let event: unknown
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))
  } catch {
    throw new WebhookError('invalid_payload')
  }
  if (
    !object(event) ||
    typeof event.id !== 'string' ||
    event.id.length !== 36 ||
    !uuid.test(event.id) ||
    event.id !== headers.eventId ||
    !validTimestamp(event.created_at) ||
    !object(event.data) ||
    typeof event.data.job_id !== 'string' ||
    event.data.job_id.length !== 36 ||
    !uuid.test(event.data.job_id)
  ) {
    throw new WebhookError('invalid_payload')
  }
  // Return only the authenticated, validated public fields; never propagate an arbitrary body.
  const common = { id: event.id, created_at: event.created_at }
  if (event.type === 'job.completed' && event.data.status === 'completed') {
    return { ...common, type: event.type, data: { job_id: event.data.job_id, status: 'completed' } }
  }
  if (event.type === 'job.failed' && event.data.status === 'failed') {
    return { ...common, type: event.type, data: { job_id: event.data.job_id, status: 'failed' } }
  }
  throw new WebhookError('invalid_payload')
}
