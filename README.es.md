# Vocloner Integrations

SDK TypeScript para servidor y guías del servidor MCP remoto de Vocloner. [English](README.md).

**Beta local `0.1.0-beta.1`.** El paquete aún no está publicado en npm. Su nombre y titularidad son
provisionales. Esta versión no acredita disponibilidad pública de API/MCP ni una validación integral
de staging. Usar el servicio habilitado consume la cuota de tu plan de Vocloner.

## Compilar e instalar localmente

Requiere Node.js 22 o 24 y npm. El SDK no tiene dependencias de ejecución.

```bash
npm ci
npm run check
mkdir -p .artifacts
npm pack --workspace @vocloner/sdk --pack-destination .artifacts
```

Instala el `.tgz` resultante en tu servidor con `npm install /ruta/absoluta/archivo.tgz`. Guarda la
clave en una variable de entorno del servidor. No incluyas este cliente en el navegador. Las claves
se crean desde tu cuenta autenticada de Vocloner; el SDK no administra cuentas, suscripciones ni
credenciales.

## Generar audio

Necesitas una voz autorizada y los permisos `voices:read`, `speech:generate`, `jobs:read` y
`audio:read`.

```typescript
import { Vocloner } from '@vocloner/sdk'

const vocloner = new Vocloner({ apiKey: process.env.VOCLONER_API_KEY! })
const voices = await vocloner.voices.list({ scope: 'mine', limit: 10 })
const voice = voices.items.find((item) => item.status === 'ready')
if (!voice) throw new Error('Primero crea o elige una voz autorizada.')

// Persiste esta clave antes de enviar. Consérvala al reintentar la misma operación.
const job = await vocloner.speech.create(
  { voice_id: voice.id, text: 'Hola desde Vocloner.', format: 'mp3' },
  { idempotencyKey: 'uuid-de-operacion-persistido' },
)
// Guarda job.id antes de esperar. Puedes reanudar por ID después de reiniciar.
const completed = await vocloner.jobs.wait(job, { timeout: 180_000 })
if (!completed.result || !('asset_id' in completed.result))
  throw new Error('El trabajo completado no tiene audio de voz.')
const audio = await vocloner.assets.download(completed.result.asset_id)
```

Ejemplos completos: [generar y guardar estado de recuperación](examples/typescript/generate.ts) y
[reanudar un trabajo existente](examples/typescript/resume.ts).

## Métodos disponibles

| Recurso        | Métodos                                           |
| -------------- | ------------------------------------------------- |
| `voices`       | `list`, `get`, `iterate`                          |
| `speech`       | `create` con `idempotencyKey` y opción `wait: 20` |
| `jobs`         | `list`, `get`, `iterate`, `wait`, `cancel`        |
| `generations`  | `list`, `get`, `iterate`                          |
| `assets`       | `stream`, `download`                              |
| `capabilities` | `get`                                             |

La beta implementa diez operaciones del contrato de 26. Cargas, clonación, diálogos, diseño,
procesamiento y mutaciones de voces/generaciones quedan para versiones posteriores. Los tipos del
contrato completo no implican métodos ya implementados para esas operaciones.

Las listas admiten `cursor` opaco y `limit` de 1 a 50. Voces añade `scope`, `search`, `language` y
`category`. Los iteradores piden páginas según se consumen.

Configuración: `apiKey`, `baseURL` (predeterminada `https://api.vocloner.org/v1`), `timeout` (30.000
ms), `maxRetries` (0–3; predeterminado 3), `fetch` opcional. Plazos, intervalos y `retryAfter` usan
milisegundos. La opción `wait: 20` expresa veinte segundos en el servidor. HTTPS obligatorio salvo
HTTP loopback explícito de desarrollo; la ruta base termina en `/v1`.

## Recuperación y límites

- Los reintentos conservan cuerpo y clave. Un conflicto no crea otra operación. Red y
  429/502/503/504 admiten reintentos acotados; `operation_pending` solo dentro del plazo
  configurado. Se respeta `Retry-After` sin acortarlo.
- `jobs.wait` no reenvía la generación. Si falla, `VoclonerError` conserva `jobId`, último trabajo
  conocido y metadatos de recuperación disponibles.
- Abortar la espera detiene la petición local. Cancelar en el servidor requiere `jobs.cancel`,
  `jobs:cancel` y el permiso de la operación original. Consulta el estado y consumo final; cancelar
  no garantiza una devolución. Consultar trabajos requiere además `jobs:read`.
- Las descargas exigen credencial vigente, rechazan redirecciones y verifican MIME, tamaño y plazo.
  Límite predeterminado de 64 MiB, configurable mediante `maxBytes`; el plazo incluye consumir el
  stream. Cancela un stream que no usarás.
- El SDK no registra claves, texto, audio ni causas de red sin sanear, y no tiene telemetría. La
  aplicación que lo integra controla sus propios registros.

Algunas mutaciones del backend pueden conservar un reclamo pendiente tras fallar. El cliente informa
la condición y limita los reintentos; no borra reclamos ni los sustituye por una nueva clave. Falta
validar por separado su recuperación en el servicio.

## MCP y webhooks

[Conexión MCP remota](docs/mcp/README.md): OAuth o clave MCP dedicada. Esa clave es distinta de la
clave REST. La beta no incluye un servidor local ni puente stdio.

`@vocloner/sdk/webhooks` ofrece `verifyWebhook` y `parseWebhook` para validar firma, antigüedad y
estructura del evento sobre los bytes originales. [Guía](docs/webhooks.md). Tu receptor debe
persistir ID y notificación en una sola transacción para deduplicar entregas.

## Desarrollo y estado de publicación

`npm run check` valida contrato/tipos, compilación, pruebas locales, formato e instalación del
tarball real en un proyecto temporal limpio. CI no usa credenciales del servicio.
[Contribuir](CONTRIBUTING.md), [seguridad](SECURITY.md), [preparar un release](docs/release.md).

El cliente tiene licencia MIT. El acceso al servicio, voces, audio y marca se rigen por sus
condiciones propias; el código abierto no añade cuota gratuita. Este proyecto no incluye el backend
ni el historial del repositorio privado.
