import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { parseWebhook, verifyWebhook, WebhookError } from '../dist/webhooks.js'

const secret = 'whsec_synthetic_test_secret'
const nowSeconds = 1794564000
const options = { nowSeconds }
const event = {
  id: '6e657fb6-cf58-46d8-9311-7f3828b203c7',
  type: 'job.completed',
  created_at: '2026-11-13T10:00:00.000Z',
  data: { job_id: 'f261e35c-420f-4c82-bd88-a0e370c936ab', status: 'completed' },
}
const bytes = (value) => new TextEncoder().encode(value)
const raw = bytes(JSON.stringify(event))

function signature(body = raw, timestamp = nowSeconds, signingSecret = secret) {
  const hash = createHmac('sha256', signingSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex')
  return `t=${timestamp},v1=${hash}`
}

function parse(body, payloadEventId = event.id) {
  return parseWebhook(
    body,
    { signature: signature(body), eventId: payloadEventId },
    secret,
    options,
  )
}

function errorCode(code) {
  return (error) => {
    assert.ok(error instanceof WebhookError)
    assert.equal(error.code, code)
    assert.equal(error.name, 'WebhookError')
    assert.equal(error.cause, undefined)
    assert.ok(!error.message.includes(secret))
    assert.ok(!error.message.includes(event.id))
    return true
  }
}

test('verifies the exact received bytes with constant-time digest comparison', () => {
  assert.equal(verifyWebhook(raw, signature(), secret, options), true)
  const unicodeBody = bytes('{"message":"Hola, voz española 🎙"}\n')
  assert.equal(verifyWebhook(unicodeBody, signature(unicodeBody), secret, options), true)
  assert.equal(
    verifyWebhook(bytes(JSON.stringify(event) + '\n'), signature(), secret, options),
    false,
  )
  assert.equal(verifyWebhook(raw, signature(), 'whsec_wrong_synthetic_secret', options), false)
  assert.equal(verifyWebhook(raw, signature(), '', options), false)
  assert.equal(verifyWebhook(raw, signature().replace(/.$/, 'x'), secret, options), false)
})

test('enforces the five minute clock window in both directions with an inclusive boundary', () => {
  for (const offset of [-301, 301]) {
    assert.equal(verifyWebhook(raw, signature(raw, nowSeconds + offset), secret, options), false)
  }
  for (const offset of [-300, 300]) {
    assert.equal(verifyWebhook(raw, signature(raw, nowSeconds + offset), secret, options), true)
  }
  assert.equal(
    verifyWebhook(raw, signature(raw, nowSeconds - 31), secret, {
      nowSeconds,
      toleranceSeconds: 30,
    }),
    false,
  )
  assert.equal(verifyWebhook(raw, signature(), secret, { nowSeconds, toleranceSeconds: 0 }), true)
})

test('rejects malformed, duplicated and ambiguous signature headers without throwing', () => {
  for (const header of [
    '',
    't=invalid,v1=abc',
    `t=${nowSeconds},v1=abc`,
    signature() + ',v1=' + '0'.repeat(64),
    `t=0${nowSeconds},v1=${'0'.repeat(64)}`,
    `t=-1,v1=${'0'.repeat(64)}`,
    `t=1234567890123,v1=${'0'.repeat(64)}`,
    signature().replace('t=', ' t='),
    signature() + '\n',
    signature() + ' ',
    null,
    undefined,
  ]) {
    assert.equal(verifyWebhook(raw, header, secret, options), false)
  }
})

test('nonfinite or out-of-range verification options cannot bypass clock validation', () => {
  for (const now of [NaN, Infinity, -Infinity, -1, '1794564000']) {
    assert.equal(verifyWebhook(raw, signature(), secret, { nowSeconds: now }), false)
  }
  for (const toleranceSeconds of [NaN, Infinity, -Infinity, -1, 301, '300']) {
    assert.equal(verifyWebhook(raw, signature(), secret, { nowSeconds, toleranceSeconds }), false)
  }
})

test('parses both job notification types with matching status and event header', () => {
  assert.deepEqual(parse(raw), event)
  const failed = { ...event, type: 'job.failed', data: { ...event.data, status: 'failed' } }
  assert.deepEqual(parse(bytes(JSON.stringify(failed))), failed)
  const extra = { ...event, unexpected: 'ignore', data: { ...event.data, internal: 'ignore' } }
  assert.deepEqual(parse(bytes(JSON.stringify(extra))), event)
})

test('signature verification happens before JSON parsing and event validation', () => {
  const malformedBody = bytes('DO NOT REFLECT THIS PRIVATE BODY')
  assert.throws(
    () =>
      parseWebhook(malformedBody, { signature: signature(), eventId: event.id }, secret, options),
    errorCode('invalid_signature'),
  )
  assert.throws(
    () =>
      parseWebhook(
        raw,
        { signature: signature(raw, nowSeconds - 301), eventId: event.id },
        secret,
        options,
      ),
    errorCode('invalid_signature'),
  )
})

test('rejects signed malformed JSON, invalid UTF-8 and non-object payloads with safe errors', () => {
  for (const body of [
    bytes('{broken'),
    bytes('null'),
    bytes('[]'),
    bytes('true'),
    new Uint8Array([0xff]),
  ]) {
    assert.throws(() => parse(body), errorCode('invalid_payload'))
  }
})

test('rejects missing or mismatched event ID headers and malformed UUIDs', () => {
  for (const eventId of ['', undefined, 'c816ce5b-22f5-4ed2-91a9-90e79b874a24']) {
    assert.throws(
      () => parseWebhook(raw, { signature: signature(), eventId }, secret, options),
      errorCode('invalid_payload'),
    )
  }
  for (const payload of [
    { ...event, id: 'invalid' },
    { ...event, id: undefined },
    { ...event, id: '6e657fb6-cf58-06d8-9311-7f3828b203c7' },
    { ...event, data: { ...event.data, job_id: 'invalid' } },
    { ...event, data: { ...event.data, job_id: 1 } },
    { ...event, data: {} },
    { ...event, data: null },
  ]) {
    assert.throws(
      () => parse(bytes(JSON.stringify(payload)), payload.id),
      errorCode('invalid_payload'),
    )
  }
})

test('requires a supported job event type, its concordant status and a real RFC3339 date', () => {
  for (const payload of [
    { ...event, type: 'job.canceled' },
    { ...event, type: 'job.failed' },
    { ...event, data: { ...event.data, status: 'failed' } },
    { ...event, data: { ...event.data, status: 'running' } },
    { ...event, created_at: undefined },
    { ...event, created_at: 'not-a-date' },
    { ...event, created_at: '2026-02-29T10:00:00Z' },
    { ...event, created_at: '2026-02-30T10:00:00Z' },
    { ...event, created_at: '2026-11-13' },
    { ...event, created_at: '2026-11-13T25:00:00Z' },
  ]) {
    assert.throws(() => parse(bytes(JSON.stringify(payload))), errorCode('invalid_payload'))
  }
  for (const created_at of ['2024-02-29T10:00:00Z', '2026-11-13T10:00:00-03:00']) {
    const payload = { ...event, created_at }
    assert.deepEqual(parse(bytes(JSON.stringify(payload))), payload)
  }
})

test('successful verification makes no durable duplicate-delivery claim', () => {
  assert.deepEqual(parse(raw), parse(raw))
})
