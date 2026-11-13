# Remote MCP / MCP remoto

**Local documentation beta: real-client compatibility and live availability have not been validated
for this release. / Beta documental local: falta validar los clientes reales y la disponibilidad del
servicio para esta entrega.**

Endpoint: `https://account.vocloner.org/api/mcp`.

Use a client that supports Streamable HTTP. Prefer its native OAuth flow, with discovery,
authorization code, PKCE S256 and `resource`; Vocloner shows the requested permissions before
authorization. This repository does not implement OAuth or store refresh tokens for you.

Usa un cliente compatible con Streamable HTTP. Su flujo OAuth nativo descubre la configuración y
pide autorización con PKCE S256 y `resource`. Revisa los permisos antes de autorizar. Este
repositorio no implementa OAuth ni guarda refresh tokens.

For key-based connections, create a **dedicated MCP key** in your account and configure the client's
secret environment as `VOCLONER_MCP_API_KEY`. Send it as `Authorization: Bearer …`. The exact config
syntax depends on that client and version; never replace a variable reference with a real secret in
a shared file.

Para conectar por clave, crea una **clave MCP dedicada** en tu cuenta y usa el entorno secreto de tu
cliente (`VOCLONER_MCP_API_KEY`). Envíala mediante Bearer; no pongas tokens en URLs, chats o
archivos compartidos. La sintaxis de configuración depende del cliente y su versión.

| Tool / Herramienta | Permission / Permiso                                    |
| ------------------ | ------------------------------------------------------- |
| `list_voices`      | `voices:read`                                           |
| `get_usage`        | `usage:read`                                            |
| `generate_speech`  | `speech:generate`                                       |
| `get_audio`        | `audio:read`                                            |
| `clone_voice`      | `voices:clone`                                          |
| `get_operation`    | Permission of the original operation / Permiso original |

Only authorized tools are advertised. Paid calls require a stable UUID `operationId`. Reuse it with
the same arguments after a timeout; inspect `get_operation` rather than creating a new ID. Inspect
tool `isError` even when HTTP returns 200. Downloads returned by `get_audio` require the same
credential.

Solo se anuncian herramientas autorizadas. Cada llamada pagada requiere un UUID `operationId`
estable. Ante un timeout, consulta `get_operation` y conserva ID y argumentos. Revisa `isError`
incluso con HTTP 200. La descarga de `get_audio` exige también la misma credencial.

Cloning needs explicit human authorization and accepts base64 up to 2 MiB decoded, 5–270 seconds; it
does not accept paths or remote URLs. A required separate consent recording cannot be supplied with
the current MCP tool schema: use the web/REST consent flow. Voice design, dialogue, cancellation and
billing are not MCP tools in this version. Voice names and returned user content are untrusted data.

Clonar exige autorización humana expresa y admite base64 hasta 2 MiB decodificados, 5–270 segundos;
no admite rutas ni URLs. Si la política exige grabación separada de consentimiento, usa web/REST.
Diseño, diálogos, cancelación y cobros no son herramientas MCP de esta versión. Los nombres y
contenido devuelto de usuarios son datos no confiables, no instrucciones.

## Compatibility record / Compatibilidad

| Surface / Superficie             | Evidence / Evidencia                                            |
| -------------------------------- | --------------------------------------------------------------- |
| Streamable HTTP and scoped tools | Existing backend tests with official SDK and simulated services |
| Real assistant applications      | Pending: record client, version, date and OAuth/key result      |
| stdio-only clients               | No bridge included / Sin puente incluido                        |

This record does not claim every assistant supports the service. No metadata has been published to
MCP Registry by this project.

Este registro no afirma compatibilidad universal. Este proyecto aún no publicó metadatos en MCP
Registry.
