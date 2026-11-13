# @vocloner/sdk

Server-side TypeScript client for Vocloner's Voices & Audio REST API. Local beta `0.1.0-beta.1`, not
yet published. Node.js 22/24, ESM, no runtime dependencies. The package name is provisional until
ownership is confirmed.

```typescript
import { Vocloner } from '@vocloner/sdk'

const client = new Vocloner({ apiKey: process.env.VOCLONER_API_KEY! })
const voices = await client.voices.list({ scope: 'mine', limit: 10 })
```

Resources: `voices.list/get/iterate`, `speech.create`, `jobs.list/get/iterate/wait/cancel`,
`generations.list/get/iterate`, `assets.stream/download`, `capabilities.get`. Writes require a
stable `idempotencyKey`. Polling never submits another generation. Local abort does not cancel the
remote job. Audio downloads enforce a 64 MiB default limit, MIME validation and a total deadline;
streams must be consumed or canceled.

`@vocloner/sdk/webhooks` separately exports raw-body HMAC/payload verification. Your receiver must
deduplicate and persist notifications transactionally.

All request timeouts and `retryAfter` values are milliseconds. `speech.create` accepts `wait: 20` in
seconds for the API's optional server wait. Set `maxRetries` to 0–3; use the same key and body after
uncertain results.

The client requires an enabled Vocloner service, account and appropriate scopes. REST keys and MCP
credentials are different. Live-service availability has not been validated by this local beta. Full
guides are included in the source repository. No telemetry, backend code or provider credentials are
included.

## Español

SDK para servidor con claves REST; no incluirlas en el navegador. Operaciones pagadas usan cuota
real. Guarda clave de idempotencia e ID del trabajo para recuperar fallos. Abortar la espera no
cancela el trabajo remoto. Esta beta local no está publicada ni valida disponibilidad productiva.
Cargas, clonación y procesamiento no tienen métodos de SDK en esta primera versión.
