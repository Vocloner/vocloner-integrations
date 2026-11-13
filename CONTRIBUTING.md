# Contributing

Use Node.js 22/24. Run `npm ci` and `npm run check`. Tests use synthetic data and injected fetch; do
not add live keys or automatic service calls to CI.

`contracts/` contains exported public JSON, not backend code. To update it, obtain a reviewed
snapshot from the contract owner and record its source commit and SHA-256 hashes in
`contracts/provenance.json`. Then run `npm run contracts:generate`. Commit the snapshot, provenance,
generated types and relevant compatibility tests together. Never edit generated types by hand or
silently discard new schema semantics.

Reproduce behavior before changing retry or cancellation rules. Preserve the same body/key after an
uncertain write, keep per-job polling metadata, and reject credential forwarding to foreign origins
and redirects.

The npm package name remains provisional until scope ownership is confirmed. The repository
destination is `Vocloner/vocloner-integrations`. No release workflow publishes a package in this
local beta.

## Español

Usa Node.js 22/24, `npm ci` y `npm run check`. Pruebas con datos sintéticos y fetch inyectado; no
añadas claves ni llamadas reales a CI. Actualiza contrato, hash, tipos y pruebas juntos. Conserva
idempotencia, permisos y límites de descarga. No copies implementación, datos o historial del
backend.
