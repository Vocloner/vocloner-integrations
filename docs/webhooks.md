# Webhook verification / Verificación

Read the original request bytes before parsing JSON. / Lee los bytes originales antes de interpretar
JSON.

```typescript
import { parseWebhook } from '@vocloner/sdk/webhooks'

const raw = new Uint8Array(await request.arrayBuffer())
const event = parseWebhook(
  raw,
  {
    signature: request.headers.get('Vocloner-Signature') ?? '',
    eventId: request.headers.get('Vocloner-Event-Id') ?? '',
  },
  process.env.VOCLONER_WEBHOOK_SECRET!,
)
// Atomically insert event.id (UNIQUE) and the notification in your database.
// Inserta event.id (UNIQUE) y la notificación en una única transacción.
```

The helper checks HMAC-SHA256, timestamp tolerance (default five minutes), event ID, type, job ID
and matching status. It does not persist or deduplicate events. Return 2xx for an already persisted
duplicate; return 5xx if persistence fails. Use your API key to fetch the authorized job result
after receiving a notification.

El helper verifica HMAC-SHA256, antigüedad (cinco minutos por defecto), ID, tipo y estado del
evento. No persiste ni deduplica. Un duplicado ya guardado responde 2xx; una persistencia fallida,
5xx. Consulta el resultado autorizado con tu clave API. Nunca registres el secreto, la firma ni el
cuerpo original.
