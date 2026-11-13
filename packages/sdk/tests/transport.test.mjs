import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { test } from 'node:test'
import { Vocloner, VoclonerError } from '../dist/index.js'

const apiKey = 'vcl_api_SYNTHETIC_TEST_KEY'
const baseURL = 'https://api.example.test/v1/'
const voiceId = 'a1111111-1111-4111-8111-111111111111'
const jobId = 'b2222222-2222-4222-8222-222222222222'
const assetId = 'c4444444-4444-4444-8444-444444444444'
const completed = {
  id: jobId,
  status: 'completed',
  status_url: `${baseURL}jobs/${jobId}`,
  result: { asset_id: assetId },
  usage: { reserved_characters: 5, billed_characters: 5, remaining_characters: 995 },
}

function client(fetch, options = {}) {
  return new Vocloner({ apiKey, baseURL, maxRetries: 0, fetch, ...options })
}

function failure(
  status,
  code,
  { headers = {}, message = 'Synthetic failure', retryable = true } = {},
) {
  return Response.json(
    { error: { code, message, request_id: 'synthetic-request', retryable } },
    { status, headers: { 'X-Request-Id': 'synthetic-request', ...headers } },
  )
}

test('unsafe API base URLs are rejected before any credential can be sent', () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return Response.json({})
  }
  for (const value of [
    'http://api.example.test/v1',
    'ftp://api.example.test/v1',
    'https://user:password@api.example.test/v1',
    'https://api.example.test/v1?secret=value',
    'https://api.example.test/v1#fragment',
    'not a URL',
  ]) {
    assert.throws(() => new Vocloner({ apiKey, baseURL: value, fetch }))
  }
  assert.equal(calls, 0)
})

test('explicit loopback HTTP configuration remains available for local development', async () => {
  const calls = []
  for (const host of ['localhost', '127.0.0.1']) {
    const sdk = client(
      async (url) => {
        calls.push(String(url))
        return Response.json({})
      },
      { baseURL: `http://${host}:3000/v1` },
    )
    await sdk.capabilities.get()
  }
  assert.deepEqual(calls, [
    'http://localhost:3000/v1/capabilities',
    'http://127.0.0.1:3000/v1/capabilities',
  ])
})

test('resource methods reject untrusted IDs before making a network request', async () => {
  let calls = 0
  const sdk = client(async () => {
    calls++
    return Response.json({})
  })
  const invalid = [
    'https://untrusted.example/collect',
    '//untrusted.example/collect',
    '../capabilities',
    `${jobId}?token=private`,
    `${jobId}/../capabilities`,
    'not-a-uuid',
    '',
  ]
  for (const id of invalid) {
    for (const invoke of [
      () => sdk.voices.get(id),
      () => sdk.jobs.get(id),
      () => sdk.jobs.wait(id),
      () => sdk.jobs.cancel(id, { idempotencyKey: 'cancel-test' }),
      () => sdk.generations.get(id),
      () => sdk.assets.download(id),
      () => sdk.assets.stream(id),
      () => sdk.speech.create({ voice_id: id, text: 'Hello' }, { idempotencyKey: 'voice-test' }),
    ]) {
      await assert.rejects(
        async () => invoke(),
        (error) => error instanceof VoclonerError,
      )
    }
  }
  assert.equal(calls, 0)
})

test('write methods require an explicit valid idempotency key at runtime', async () => {
  let calls = 0
  const sdk = client(async () => {
    calls++
    return Response.json(completed)
  })
  for (const options of [
    undefined,
    {},
    { idempotencyKey: '' },
    { idempotencyKey: ' ' },
    { idempotencyKey: 'bad\nheader' },
  ]) {
    await assert.rejects(async () =>
      sdk.speech.create({ voice_id: voiceId, text: 'Hello' }, options),
    )
    await assert.rejects(async () => sdk.jobs.cancel(jobId, options))
  }
  assert.equal(calls, 0)
})

test('a network retry and transient HTTP retry reuse exactly the serialized body and key', async () => {
  const calls = []
  const input = { voice_id: voiceId, text: 'Original text', format: 'mp3' }
  const sdk = client(
    async (url, init) => {
      calls.push({ url: String(url), body: init.body, headers: new Headers(init.headers) })
      if (calls.length === 1) {
        input.text = 'Changed by the application after submission'
        throw new TypeError('Synthetic connection loss')
      }
      if (calls.length === 2)
        return failure(503, 'service_unavailable', { headers: { 'Retry-After': '0' } })
      return Response.json(completed)
    },
    { maxRetries: 2, timeout: 10_000 },
  )

  assert.equal((await sdk.speech.create(input, { idempotencyKey: 'stable-write-001' })).id, jobId)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(({ body }) => body === calls[0].body))
  assert.equal(JSON.parse(calls[0].body).text, 'Original text')
  assert.ok(calls.every(({ headers }) => headers.get('Idempotency-Key') === 'stable-write-001'))
})

test('authentication, permission and idempotency conflicts are never retried', async () => {
  for (const [status, code] of [
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [409, 'idempotency_conflict'],
  ]) {
    let calls = 0
    const sdk = client(
      async () => {
        calls++
        return failure(status, code, { headers: { 'Retry-After': '0' } })
      },
      { maxRetries: 3 },
    )

    await assert.rejects(
      sdk.speech.create(
        { voice_id: voiceId, text: 'Hello' },
        { idempotencyKey: 'stable-write-002' },
      ),
      (error) => {
        assert.ok(error instanceof VoclonerError)
        assert.equal(error.code, code)
        assert.equal(error.status, status)
        assert.equal(error.requestId, 'synthetic-request')
        assert.equal(error.idempotencyKey, 'stable-write-002')
        assert.equal(error.retryable, false)
        return true
      },
    )
    assert.equal(calls, 1)
  }
})

test('operation_pending retries are bounded and retain their recovery identity', async () => {
  const calls = []
  const sdk = client(
    async (_url, init) => {
      calls.push({ body: init.body, key: new Headers(init.headers).get('Idempotency-Key') })
      return failure(409, 'operation_pending', { headers: { 'Retry-After': '0' } })
    },
    { maxRetries: 2 },
  )

  await assert.rejects(
    sdk.speech.create(
      { voice_id: voiceId, text: 'Hello' },
      { idempotencyKey: 'pending-write-001' },
    ),
    (error) => {
      assert.ok(error instanceof VoclonerError)
      assert.equal(error.code, 'operation_pending')
      assert.equal(error.status, 409)
      assert.equal(error.idempotencyKey, 'pending-write-001')
      assert.equal(error.retryable, true)
      return true
    },
  )
  assert.equal(calls.length, 3)
  assert.ok(calls.every(({ body, key }) => body === calls[0].body && key === 'pending-write-001'))
})

test('Retry-After beyond the request deadline is surfaced without shortening the server delay', async () => {
  let calls = 0
  const sdk = client(
    async () => {
      calls++
      return failure(429, 'rate_limited', { headers: { 'Retry-After': '60' } })
    },
    { maxRetries: 3, timeout: 20 },
  )

  await assert.rejects(sdk.capabilities.get(), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.retryAfter, 60_000)
    return true
  })
  assert.equal(calls, 1)
})

test('HTTP-date Retry-After is interpreted relative to the response time', async (t) => {
  const now = Date.parse('2026-11-13T12:00:00.000Z')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now })
  const sdk = client(
    async () =>
      failure(503, 'service_unavailable', {
        headers: { 'Retry-After': new Date(now + 30_000).toUTCString() },
      }),
    { maxRetries: 1, timeout: 100 },
  )

  await assert.rejects(sdk.capabilities.get(), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.retryAfter, 30_000)
    return true
  })
})

test('maxRetries zero disables retries even for transient HTTP failures', async () => {
  let calls = 0
  const sdk = client(async () => {
    calls++
    return failure(503, 'service_unavailable')
  })
  await assert.rejects(sdk.capabilities.get(), (error) => error instanceof VoclonerError)
  assert.equal(calls, 1)
})

test('JSON requests and audio requests disable redirects and never follow a Location header', async () => {
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://untrusted.example/collect' },
    })
  })
  await assert.rejects(sdk.capabilities.get())
  await assert.rejects(sdk.assets.download(assetId))
  assert.equal(calls.length, 2)
  assert.ok(calls.every(({ url }) => url.startsWith(baseURL)))
  assert.ok(calls.every(({ init }) => init.redirect === 'error'))
})

test('aborting an HTTP request propagates locally without making a cancel request', async () => {
  const controller = new AbortController()
  const calls = []
  const sdk = client(
    async (url, init) => {
      calls.push({ url: String(url), method: init.method })
      return new Promise((_resolve, reject) => {
        const abort = () => reject(init.signal.reason)
        if (init.signal.aborted) abort()
        else init.signal.addEventListener('abort', abort, { once: true })
      })
    },
    { maxRetries: 3 },
  )
  const request = sdk.jobs.get(jobId, { signal: controller.signal })
  controller.abort(new Error('private cancellation reason'))

  await assert.rejects(request, (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.doesNotMatch(String(error), /private cancellation reason/)
    return true
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('server and network failures do not expose keys, input text, raw response messages or logs', async (t) => {
  const privateText = 'Synthetic private transcript, never disclose this'
  const leaked = `Bearer ${apiKey}; ${privateText}`
  const logs = []
  for (const method of ['log', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...arguments_) => {
      logs.push(arguments_)
    })
  for (const fetch of [
    async () => failure(422, 'validation_failed', { message: leaked, retryable: false }),
    async () => {
      throw new Error(leaked)
    },
  ]) {
    const sdk = client(fetch)
    await assert.rejects(
      sdk.speech.create(
        { voice_id: voiceId, text: privateText },
        { idempotencyKey: 'safe-error-001' },
      ),
      (error) => {
        assert.ok(error instanceof VoclonerError)
        const rendered = `${String(error)}\n${JSON.stringify(error)}\n${inspect(error, { depth: 5 })}`
        assert.equal(rendered.includes(apiKey), false)
        assert.equal(rendered.includes(privateText), false)
        return true
      },
    )
  }
  assert.deepEqual(logs, [])
})

test('audio downloads return bytes and authenticate only the controlled asset route', async () => {
  const calls = []
  const bytes = new Uint8Array([73, 68, 51, 0, 1])
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(bytes, {
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length) },
    })
  })

  const received = await sdk.assets.download(assetId, { maxBytes: 10 })
  assert.ok(received instanceof Uint8Array)
  assert.deepEqual(received, bytes)
  assert.equal(calls[0].url, `${baseURL}assets/${assetId}/content`)
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), `Bearer ${apiKey}`)
})

test('non-audio payloads and declared oversized downloads are rejected', async () => {
  for (const headers of [
    { 'Content-Type': 'application/json' },
    { 'Content-Type': 'text/html' },
    { 'Content-Type': 'audio/mpeg', 'Content-Length': '11' },
  ]) {
    const sdk = client(async () => new Response(new Uint8Array([1, 2, 3]), { headers }))
    await assert.rejects(
      sdk.assets.download(assetId, { maxBytes: 10 }),
      (error) => error instanceof VoclonerError,
    )
  }
})

test('the byte limit is enforced while reading even without a trustworthy Content-Length', async () => {
  let canceled = false
  let chunks = 0
  const sdk = client(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]))
            chunks++
            if (chunks === 4) controller.close()
          },
          cancel() {
            canceled = true
          },
        }),
        { headers: { 'Content-Type': 'audio/wav' } },
      ),
  )

  await assert.rejects(
    sdk.assets.download(assetId, { maxBytes: 5 }),
    (error) => error instanceof VoclonerError,
  )
  assert.equal(canceled, true)
  assert.ok(chunks < 4, 'the oversized body is not fully buffered')
})

test('audio streaming preserves chunk delivery and sanitizes interrupted reads without retrying', async () => {
  let calls = 0
  let pulls = 0
  const sdk = client(
    async () => {
      calls++
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]))
              else controller.error(new Error(`upstream secret ${apiKey}`))
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'Content-Type': 'audio/mpeg' } },
      )
    },
    { maxRetries: 3 },
  )

  const stream = await sdk.assets.stream(assetId)
  assert.ok(stream instanceof ReadableStream)
  const reader = stream.getReader()
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1, 2, 3]) })
  await assert.rejects(reader.read(), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(inspect(error).includes(apiKey), false)
    return true
  })
  assert.equal(calls, 1, 'an interrupted stream is not silently restarted')
})

test('a truncated audio response is rejected even when its stream closes normally', async () => {
  const sdk = client(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '5' },
      }),
  )

  await assert.rejects(sdk.assets.download(assetId), (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.equal(error.code, 'download_incomplete')
    return true
  })
})

test('aborting an audio stream stops a pending read and closes its source locally', async () => {
  const controller = new AbortController()
  let canceled = false
  const calls = []
  const sdk = client(async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {})
        },
        cancel() {
          canceled = true
        },
      }),
      { headers: { 'Content-Type': 'audio/wav' } },
    )
  })
  const stream = await sdk.assets.stream(assetId, { signal: controller.signal })
  const reader = stream.getReader()
  const pendingRead = reader.read()
  controller.abort(new Error('private audio abort reason'))

  await assert.rejects(pendingRead, (error) => {
    assert.ok(error instanceof VoclonerError)
    assert.doesNotMatch(String(error), /private audio abort reason/)
    return true
  })
  assert.equal(canceled, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('a truncated accepted response preserves the server Job ID without repeating the paid POST', async () => {
  const calls = []
  const sdk = client(
    async (url, init) => {
      calls.push({ url: String(url), method: init.method })
      return new Response('{"id":', {
        status: 202,
        headers: {
          'Content-Type': 'application/json',
          'X-Job-Id': jobId,
          'X-Request-Id': 'accepted-but-truncated',
        },
      })
    },
    { maxRetries: 3 },
  )

  await assert.rejects(
    sdk.speech.create(
      { voice_id: voiceId, text: 'Hello' },
      { idempotencyKey: 'truncated-write-001' },
    ),
    (error) => {
      assert.ok(error instanceof VoclonerError)
      assert.equal(error.jobId, jobId)
      assert.equal(error.idempotencyKey, 'truncated-write-001')
      assert.equal(error.requestId, 'accepted-but-truncated')
      return true
    },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
})

test('a well-formed JSON body with a missing Job retains recovery headers when rejected', async () => {
  let calls = 0
  const sdk = client(
    async () => {
      calls++
      return Response.json(
        {},
        {
          status: 202,
          headers: { 'X-Job-Id': jobId, 'X-Request-Id': 'accepted-invalid-resource' },
        },
      )
    },
    { maxRetries: 3 },
  )

  await assert.rejects(
    sdk.speech.create(
      { voice_id: voiceId, text: 'Hello' },
      { idempotencyKey: 'invalid-write-result' },
    ),
    (error) => {
      assert.ok(error instanceof VoclonerError)
      assert.equal(error.code, 'invalid_response')
      assert.equal(error.jobId, jobId)
      assert.equal(error.idempotencyKey, 'invalid-write-result')
      assert.equal(error.requestId, 'accepted-invalid-resource')
      return true
    },
  )
  assert.equal(calls, 1, 'invalid response data does not trigger another paid POST')
})

test('a rejected upstream stream cancellation exposes only a safe VoclonerError', async () => {
  const privateMessage = `private upstream cancellation; ${apiKey}`
  let calls = 0
  let cancellations = 0
  const sdk = client(async () => {
    calls++
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {})
        },
        cancel() {
          cancellations++
          return Promise.reject(new Error(privateMessage))
        },
      }),
      { headers: { 'Content-Type': 'audio/wav' } },
    )
  })
  const stream = await sdk.assets.stream(assetId)

  await assert.rejects(stream.cancel('private application cancellation reason'), (error) => {
    assert.ok(error instanceof VoclonerError)
    const rendered = `${String(error)}\n${JSON.stringify(error)}\n${inspect(error, { depth: 5 })}`
    assert.equal(rendered.includes(privateMessage), false)
    assert.equal(rendered.includes(apiKey), false)
    assert.equal(rendered.includes('private application cancellation reason'), false)
    return true
  })
  assert.equal(calls, 1)
  assert.equal(cancellations, 1)
})

test('a hanging upstream stream cancellation is bounded by the download deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  let cancellations = 0
  const sdk = client(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          },
          cancel() {
            cancellations++
            return new Promise(() => {})
          },
        }),
        { headers: { 'Content-Type': 'audio/mpeg' } },
      ),
  )
  const stream = await sdk.assets.stream(assetId, { timeout: 25 })
  let settled = false
  const cancellation = stream.cancel('private cancellation reason').then(
    () => {
      settled = true
      return undefined
    },
    (error) => {
      settled = true
      return error
    },
  )

  t.mock.timers.tick(25)
  for (let index = 0; index < 40; index++) await Promise.resolve()
  assert.equal(settled, true, 'the download deadline must also bound upstream cancellation')
  const error = await cancellation
  assert.ok(error instanceof VoclonerError)
  assert.ok(['timeout', 'download_interrupted'].includes(error.code))
  assert.doesNotMatch(inspect(error), /private cancellation reason/)
  assert.equal(cancellations, 1)
})

test('a parent AbortSignal releases a hanging stream cancellation without leaking its reason', async () => {
  const controller = new AbortController()
  let cancellations = 0
  const sdk = client(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          },
          cancel() {
            cancellations++
            return new Promise(() => {})
          },
        }),
        { headers: { 'Content-Type': 'audio/mpeg' } },
      ),
  )
  const stream = await sdk.assets.stream(assetId, { signal: controller.signal })
  let settled = false
  const cancellation = stream.cancel('private stream cancellation reason').then(
    () => {
      settled = true
      return undefined
    },
    (error) => {
      settled = true
      return error
    },
  )
  controller.abort(new Error(`private parent cancellation reason; ${apiKey}`))
  for (let index = 0; index < 40; index++) await Promise.resolve()

  assert.equal(settled, true, 'aborting the download must also release upstream cancellation')
  const error = await cancellation
  assert.ok(error instanceof VoclonerError)
  assert.ok(['aborted', 'download_interrupted'].includes(error.code))
  const rendered = `${String(error)}\n${JSON.stringify(error)}\n${inspect(error, { depth: 5 })}`
  assert.equal(rendered.includes(apiKey), false)
  assert.equal(rendered.includes('private parent cancellation reason'), false)
  assert.equal(rendered.includes('private stream cancellation reason'), false)
  assert.equal(cancellations, 1)
})
