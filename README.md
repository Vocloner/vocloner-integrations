# Vocloner Integrations

Server-side TypeScript SDK and connection guides for Vocloner's remote MCP server.
[Español](README.es.md).

**Local beta `0.1.0-beta.1`.** This package has not been published to npm. The package name and
ownership are provisional. Live API/MCP availability and staging end-to-end checks have not been
verified for this release. Using an enabled service consumes your existing Vocloner plan's quota.

## Build and install locally

Requires Node.js 22 or 24 and npm. The SDK has no runtime dependencies.

```bash
npm ci
npm run check
mkdir -p .artifacts
npm pack --workspace @vocloner/sdk --pack-destination .artifacts
```

Install the resulting `.tgz` in your server application with
`npm install /absolute/path/to/file.tgz`. Keep your API key in a server environment variable. Do not
use this client in a browser bundle. Create keys in your authenticated Vocloner account; the SDK
does not manage accounts, subscriptions or credentials.

## Generate speech

Choose a voice you are authorized to use. This example needs `voices:read`, `speech:generate`,
`jobs:read` and `audio:read`.

```typescript
import { Vocloner, VoclonerError } from '@vocloner/sdk'

const vocloner = new Vocloner({ apiKey: process.env.VOCLONER_API_KEY! })
const voices = await vocloner.voices.list({ scope: 'mine', limit: 10 })
const voice = voices.items.find((item) => item.status === 'ready')
if (!voice) throw new Error('Create or select an authorized voice first.')

// Persist this key before submission. Reuse it after a lost response.
const idempotencyKey = 'your-persisted-operation-uuid'
try {
  const job = await vocloner.speech.create(
    { voice_id: voice.id, text: 'Hello from Vocloner.', format: 'mp3' },
    { idempotencyKey },
  )
  // Persist job.id before waiting. Resume by ID after a process restart.
  const completed = await vocloner.jobs.wait(job, { timeout: 180_000 })
  if (!completed.result || !('asset_id' in completed.result))
    throw new Error('The completed job has no speech asset.')
  const audio = await vocloner.assets.download(completed.result.asset_id)
  // Save audio or stream it to your own authorized application user.
} catch (error) {
  if (error instanceof VoclonerError) {
    // Store only safe diagnostics: code, requestId, jobId and idempotencyKey.
    // An aborted wait or timeout does not cancel remote work.
  }
  throw error
}
```

Working examples: [generate and persist recovery state](examples/typescript/generate.ts) and
[resume an existing job](examples/typescript/resume.ts).

## Supported in this beta

| Resource       | Methods                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `voices`       | `list(query?, options?)`, `get(id, options?)`, `iterate(query?, options?)`      |
| `speech`       | `create(input, { idempotencyKey, wait?: 20, signal?, timeout? })`               |
| `jobs`         | `list`, `get`, `iterate`, `wait(idOrJob, options?)`, `cancel(id, writeOptions)` |
| `generations`  | `list`, `get`, `iterate`                                                        |
| `assets`       | `stream(id, options?)`, `download(id, options?)`                                |
| `capabilities` | `get(options?)`                                                                 |

The contract snapshot describes 26 operations. This SDK beta implements the ten operations listed
above. Uploads, cloning, dialogue, voice design, audio processing and voice/generation mutation
methods are planned for subsequent versions.

Lists accept opaque `cursor` and `limit` (1–50). Voice filters also include `scope`, `search`,
`language` and `category`. Iterators fetch the next page on demand.

`Vocloner` accepts `baseURL` (default `https://api.vocloner.org/v1`), `timeout` (30,000 ms),
`maxRetries` (0–3, default 3), and an optional injected `fetch`. All timeouts, polling intervals and
`retryAfter` metadata are in milliseconds; `wait: 20` is the API's server wait in seconds. HTTPS is
required except for explicit HTTP loopback development URLs ending in `/v1`.

## Recovery, cancellation and downloads

- Writes require a caller-supplied, stable `idempotencyKey`. Automatic retries keep exactly the same
  body and key. Conflicts never generate a fresh key.
- Network failures and 429/502/503/504 use bounded retries. `operation_pending` may be retried
  within the same deadline. `Retry-After` takes precedence over backoff.
- `jobs.wait` polls the same job and exposes `jobId` and its last known `job` in `VoclonerError` on
  failure. A local abort stops the request, not the remote job.
- `jobs.cancel` is explicit and needs `jobs:cancel` plus the original operation's permission. Check
  the returned state and final usage; cancellation is not a promise of a refund. Polling also needs
  `jobs:read` and the original permission.
- Audio uses authenticated requests, with redirects rejected. Streams enforce a 64 MiB default limit
  and a total deadline, including consumption. Override `maxBytes`/`timeout` when appropriate.
  Cancel a stream you will not consume.
- No API keys, request text, audio, server error messages or raw fetch causes are logged or attached
  to SDK errors. This library has no telemetry.

The backend's durable mutation claim can remain pending after certain failures; this SDK reports the
condition and bounds retries. It does not clear claims or resubmit under a different key.
Service-side recovery needs separate validation.

## MCP and webhooks

[Remote MCP setup](docs/mcp/README.md) uses Vocloner's existing Streamable HTTP server with OAuth or
a dedicated MCP key. REST and MCP credentials are separate. There is no local MCP server or stdio
bridge in this beta.

`@vocloner/sdk/webhooks` exports `verifyWebhook` and `parseWebhook` for raw-body signature and
payload validation. [Webhook guide](docs/webhooks.md). Persist the event ID and notification
atomically to deduplicate deliveries in your own database.

## Development and release state

`npm run check` verifies generated public types, compilation, local tests, formatting and
installation of the actual package tarball in a clean temporary project. CI uses no service
credentials. [Contributing](CONTRIBUTING.md), [security](SECURITY.md),
[release checklist](docs/release.md).

The SDK code is MIT licensed. The hosted service, voices, generated audio and Vocloner trademarks
are governed separately; the license does not grant free service access. No backend code or private
repository history is included.
