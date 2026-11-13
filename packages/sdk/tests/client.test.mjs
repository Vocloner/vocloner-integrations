import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Vocloner, VoclonerError } from '../dist/index.js'

const apiKey = 'vcl_api_SYNTHETIC_TEST_KEY'
const baseURL = 'https://api.example.test/v1/'
const voiceId = 'a1111111-1111-4111-8111-111111111111'
const jobId = 'b2222222-2222-4222-8222-222222222222'
const secondJobId = 'b3333333-3333-4333-8333-333333333333'
const assetId = 'c4444444-4444-4444-8444-444444444444'
const timestamp = '2026-11-13T12:00:00.000Z'

function job(status = 'queued', overrides = {}) {
  return {
    id: jobId,
    operation: 'speech',
    status,
    status_url: `${baseURL}jobs/${jobId}`,
    created_at: timestamp,
    started_at: null,
    completed_at: status === 'completed' ? timestamp : null,
    cancel_requested: status === 'canceled',
    result:
      status === 'completed'
        ? {
            generation_id: jobId,
            asset_id: assetId,
            audio_url: `${baseURL}assets/${assetId}/content`,
            format: 'mp3',
            duration_ms: 1000,
          }
        : null,
    error: status === 'failed' ? { code: 'generation_failed' } : null,
    usage: { reserved_characters: 5, billed_characters: 0, remaining_characters: 995 },
    ...overrides,
  }
}

function json(body, { status = 200, headers = {} } = {}) {
  return Response.json(body, { status, headers })
}

function client(fetch, options = {}) {
  return new Vocloner({ apiKey, baseURL, maxRetries: 0, fetch, ...options })
}

async function flushMicrotasks() {
  for (let index = 0; index < 40; index++) await Promise.resolve()
}

test('speech accepts a synchronous completed Job and sends the explicit write identity', async () => {
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), init })
    return json(job('completed'))
  })
  const completed = await sdk.speech.create(
    { voice_id: voiceId, text: 'Hello', format: 'mp3' },
    { idempotencyKey: 'synthetic-tts-001', wait: 20 },
  )

  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.asset_id, assetId)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${baseURL}speech`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), `Bearer ${apiKey}`)
  assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'), 'synthetic-tts-001')
  assert.equal(new Headers(calls[0].init.headers).get('Prefer'), 'wait=20')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    voice_id: voiceId,
    text: 'Hello',
    format: 'mp3',
  })
  assert.deepEqual(await sdk.jobs.wait(completed), completed)
  assert.equal(calls.length, 1, 'a terminal Job does not need another network request')
})

test('an accepted generation is polled through reconciling without duplicating its POST', async () => {
  const calls = []
  const states = [
    job('queued', { status_url: 'https://untrusted.example/jobs/stolen' }),
    job('running'),
    job('reconciling'),
    job('completed'),
  ]
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    return json(states.shift(), {
      status: calls.length === 1 ? 202 : 200,
      headers: { 'Retry-After': '0' },
    })
  })

  const accepted = await sdk.speech.create(
    { voice_id: voiceId, text: 'Hello' },
    { idempotencyKey: 'synthetic-tts-002' },
  )
  const completed = await sdk.jobs.wait(accepted, { pollInterval: 1, timeout: 1000 })

  assert.equal(completed.status, 'completed')
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['POST', 'GET', 'GET', 'GET'],
  )
  assert.ok(calls.slice(1).every(({ url }) => url === `${baseURL}jobs/${jobId}`))
})

test('voice iteration preserves filters and treats each returned cursor as an opaque value', async () => {
  const cursor = 'opaque+/=?&scope=mine#fragment'
  const calls = []
  const filters = {
    scope: 'public',
    search: 'Ana & Luis / 日本語',
    language: 'es',
    category: 'narrator',
    limit: 1,
  }
  const sdk = client(async (url) => {
    calls.push(new URL(String(url)))
    return json(
      calls.length === 1
        ? { items: [{ id: voiceId, name: 'First' }], next_cursor: cursor }
        : { items: [{ id: assetId, name: 'Second' }], next_cursor: null },
    )
  })

  const voices = []
  for await (const voice of sdk.voices.iterate(filters)) voices.push(voice)

  assert.deepEqual(
    voices.map(({ name }) => name),
    ['First', 'Second'],
  )
  assert.equal(calls.length, 2)
  for (const url of calls) {
    assert.equal(url.origin, 'https://api.example.test')
    assert.equal(url.pathname, '/v1/voices')
    assert.equal(url.hash, '')
    for (const [name, value] of Object.entries(filters))
      assert.equal(url.searchParams.get(name), String(value))
  }
  assert.equal(calls[0].searchParams.has('cursor'), false)
  assert.equal(calls[1].searchParams.get('cursor'), cursor)
  assert.equal(calls[1].searchParams.getAll('scope').length, 1)
})

test('the history iterator follows the cursor and can be stopped without fetching later pages', async () => {
  const calls = []
  const sdk = client(async (url) => {
    calls.push(new URL(String(url)))
    return json({
      items: [{ id: jobId, status: 'completed' }],
      next_cursor: calls.length === 1 ? 'second+page/=' : 'unused-page',
    })
  })

  const ids = []
  for await (const generation of sdk.generations.iterate({ limit: 1 })) {
    ids.push(generation.id)
    if (ids.length === 2) break
  }

  assert.deepEqual(ids, [jobId, jobId])
  assert.equal(calls.length, 2)
  assert.ok(calls.every((url) => url.pathname === '/v1/generations'))
  assert.equal(calls[1].searchParams.get('cursor'), 'second+page/=')
})

test('read methods retain the configured API prefix and do not invent extra calls', async () => {
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: new URL(String(url)), method: init.method })
    return json(
      String(url).endsWith(`/jobs/${jobId}`)
        ? job('completed')
        : { items: [], next_cursor: null, id: jobId },
    )
  })

  await sdk.voices.get(voiceId)
  await sdk.jobs.list({ cursor: 'opaque-job-cursor', limit: 7 })
  await sdk.jobs.get(jobId)
  await sdk.generations.list({ cursor: 'opaque-generation-cursor', limit: 4 })
  await sdk.generations.get(jobId)
  await sdk.capabilities.get()

  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    [
      `/v1/voices/${voiceId}`,
      '/v1/jobs',
      `/v1/jobs/${jobId}`,
      '/v1/generations',
      `/v1/generations/${jobId}`,
      '/v1/capabilities',
    ],
  )
  assert.ok(calls.every(({ method }) => method === 'GET'))
  assert.equal(calls[1].url.searchParams.get('cursor'), 'opaque-job-cursor')
  assert.equal(calls[1].url.searchParams.get('limit'), '7')
  assert.equal(calls[3].url.searchParams.get('cursor'), 'opaque-generation-cursor')
})

test('cancel is an explicit idempotent remote operation', async () => {
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), init })
    return json(job('canceled'))
  })

  const canceled = await sdk.jobs.cancel(jobId, { idempotencyKey: 'synthetic-cancel-001' })

  assert.equal(canceled.status, 'canceled')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${baseURL}jobs/${jobId}/cancel`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'), 'synthetic-cancel-001')
})

test('failed and canceled Jobs retain their identity and final usage in errors', async () => {
  let requests = 0
  const sdk = client(async () => {
    requests++
    assert.fail('a supplied terminal Job must not be fetched again')
  })

  for (const status of ['failed', 'canceled']) {
    const terminal = job(status, {
      usage: { reserved_characters: 5, billed_characters: 2, remaining_characters: 998 },
    })
    await assert.rejects(sdk.jobs.wait(terminal), (error) => {
      assert.ok(error instanceof VoclonerError)
      assert.equal(error.jobId, jobId)
      assert.deepEqual(error.job, terminal)
      assert.equal(error.retryable, false)
      return true
    })
  }
  assert.equal(requests, 0)
})

test('a polling deadline shorter than Retry-After exposes the Job for recovery', async () => {
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    return json(job('reconciling'), { headers: { 'Retry-After': '60' } })
  })
  const known = await sdk.jobs.get(jobId)

  await assert.rejects(sdk.jobs.wait(known, { timeout: 20 }), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.jobId, jobId)
    assert.equal(error.job.status, 'reconciling')
    assert.equal(error.retryAfter, 60_000)
    return true
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('aborting polling leaves the remote Job running and returns its identity', async () => {
  const controller = new AbortController()
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    return json(job('running'), { headers: { 'Retry-After': '60' } })
  })
  const known = await sdk.jobs.get(jobId)
  const waiting = sdk.jobs.wait(known, { signal: controller.signal, timeout: 120_000 })
  controller.abort(new Error('private cancellation reason'))

  await assert.rejects(waiting, (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.jobId, jobId)
    assert.equal(error.job.status, 'running')
    assert.doesNotMatch(String(error), /private cancellation reason/)
    return true
  })
  assert.equal(calls.length, 1)
  assert.ok(calls.every(({ method }) => method === 'GET'))
})

test('concurrent waits keep each response Retry-After separate from unrelated requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  const calls = []
  let created = 0
  const sdk = client(
    async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push({ path, method: init.method, at: Date.now() })
      if (init.method === 'POST') {
        const id = created++ === 0 ? jobId : secondJobId
        return json(job('queued', { id }), {
          status: 202,
          headers: { 'Retry-After': id === jobId ? '2' : '7' },
        })
      }
      if (path.endsWith('/capabilities')) return json({}, { headers: { 'Retry-After': '99' } })
      const id = path.split('/').at(-1)
      return json(job('completed', { id }))
    },
    { timeout: 30_000 },
  )
  const first = await sdk.speech.create(
    { voice_id: voiceId, text: 'First' },
    { idempotencyKey: 'concurrent-first' },
  )
  const second = await sdk.speech.create(
    { voice_id: voiceId, text: 'Second' },
    { idempotencyKey: 'concurrent-second' },
  )
  await sdk.capabilities.get()
  const waits = [
    sdk.jobs.wait(first, { timeout: 20_000 }),
    sdk.jobs.wait(second, { timeout: 20_000 }),
  ]
  await flushMicrotasks()
  const polled = () => calls.filter(({ path }) => path.startsWith('/v1/jobs/'))

  t.mock.timers.tick(1999)
  await flushMicrotasks()
  assert.equal(polled().length, 0)
  t.mock.timers.tick(1)
  await flushMicrotasks()
  assert.deepEqual(
    polled().map(({ path }) => path),
    [`/v1/jobs/${jobId}`],
  )
  t.mock.timers.tick(4999)
  await flushMicrotasks()
  assert.equal(polled().length, 1)
  t.mock.timers.tick(1)
  await flushMicrotasks()
  assert.deepEqual(
    polled().map(({ path }) => path),
    [`/v1/jobs/${jobId}`, `/v1/jobs/${secondJobId}`],
  )
  assert.deepEqual(
    (await Promise.all(waits)).map(({ status }) => status),
    ['completed', 'completed'],
  )
})

test('the polling deadline also bounds a stalled HTTP request and preserves the Job ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    return new Promise(() => {})
  })
  const rejected = assert.rejects(sdk.jobs.wait(jobId, { timeout: 25 }), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.jobId, jobId)
    return true
  })

  await flushMicrotasks()
  t.mock.timers.tick(25)
  await rejected
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('a repeated server cursor ends iteration with an error instead of an endless loop', async () => {
  let calls = 0
  const sdk = client(async () => {
    calls++
    assert.ok(calls <= 2, 'iteration must stop when the same cursor repeats')
    return json({ items: [], next_cursor: 'repeated-cursor' })
  })

  await assert.rejects(
    async () => {
      for await (const _voice of sdk.voices.iterate()) {
        assert.fail('the synthetic pages contain no items')
      }
    },
    (error) => error instanceof VoclonerError,
  )
  assert.equal(calls, 2)
})

test('a wait error retains the original write key after later polling responses', async () => {
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    return calls.length === 1
      ? json(job('queued'), { status: 202, headers: { 'Retry-After': '0' } })
      : json(job('running'), { headers: { 'Retry-After': '60', 'X-Request-Id': 'latest-poll' } })
  })
  const submitted = await sdk.speech.create(
    { voice_id: voiceId, text: 'Hello' },
    { idempotencyKey: 'recover-original-write' },
  )

  await assert.rejects(sdk.jobs.wait(submitted, { timeout: 1000 }), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.idempotencyKey, 'recover-original-write')
    assert.equal(error.jobId, jobId)
    assert.equal(error.job.status, 'running')
    assert.equal(error.requestId, 'latest-poll')
    return true
  })
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['POST', 'GET'],
  )
})

test('a UUID written with uppercase hexadecimal matches the canonical server Job ID', async () => {
  let calls = 0
  const sdk = client(async () => {
    calls++
    return json(job('completed'))
  })

  const found = await sdk.jobs.get(jobId.toUpperCase())

  assert.equal(found.id, jobId)
  assert.equal(calls, 1)
})

test('an invalid supplied Job is rejected without leaving a deadline timer running', async (t) => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const active = new Set()
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args)
    active.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    active.delete(timer)
    return originalClearTimeout(timer)
  })
  let calls = 0
  const sdk = client(async () => {
    calls++
    assert.fail('an invalid supplied Job must be rejected before requesting it')
  })

  try {
    await assert.rejects(sdk.jobs.wait(job('bogus'), { timeout: 10_000 }), (error) => {
      assert.ok(error instanceof VoclonerError)
      assert.equal(error.code, 'invalid_response')
      return true
    })
    assert.equal(active.size, 0, 'rejecting invalid input must release any created deadline timer')
    assert.equal(calls, 0)
  } finally {
    for (const timer of active) originalClearTimeout(timer)
  }
})

test('a cancellation response for another Job is rejected with the requested operation context', async () => {
  let calls = 0
  const sdk = client(async () => {
    calls++
    return json(job('canceled', { id: secondJobId }), {
      headers: { 'X-Job-Id': secondJobId, 'X-Request-Id': 'wrong-cancel-result' },
    })
  })

  await assert.rejects(sdk.jobs.cancel(jobId, { idempotencyKey: 'cancel-wrong-job' }), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.code, 'invalid_response')
    assert.equal(error.jobId, jobId)
    assert.equal(error.idempotencyKey, 'cancel-wrong-job')
    assert.equal(error.requestId, 'wrong-cancel-result')
    return true
  })
  assert.equal(calls, 1)
})
