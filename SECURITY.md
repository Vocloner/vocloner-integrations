# Security

Do not include API keys, signatures, signed upload URLs, audio, text or account data in issues or
logs. Useful diagnostics: SDK/runtime version, error code, request ID and a synthetic reproduction.
Do not post private job data publicly.

A private security reporting channel has not been configured yet. Contact the maintainer through an
existing private channel until a real security reporting route is configured; no fictional contact
address is provided.

This SDK makes server-side requests. Use a separate key per integration with minimum scopes. REST
keys cannot authenticate MCP. Do not open browser CORS or expose service/provider credentials to
make the SDK work.

Known release limits: no live-service validation; pending backend mutation recovery; no upload
helper yet. Reporting a pending operation never authorizes clearing the server ledger or repeating
paid work under a new key.

## Español

No publiques claves, firmas, URLs firmadas, audio, texto ni datos de cuenta. Comparte versión,
código de error y request ID por un canal privado existente. Falta configurar el canal real de
reporte antes de publicar el repositorio. La beta no valida disponibilidad del servicio ni
recuperación del backend.
