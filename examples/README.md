# Examples / Ejemplos

These examples call the configured service and can consume real characters. They are not run by CI.
/ Estos ejemplos consumen caracteres reales y CI no los ejecuta.

From the repository root, after `npm ci` and `npm run build`:

```bash
export VOCLONER_API_KEY='YOUR_REST_KEY'
export VOCLONER_VOICE_ID='YOUR_AUTHORIZED_VOICE_UUID'
export VOCLONER_IDEMPOTENCY_KEY='YOUR_PERSISTED_OPERATION_UUID'
./node_modules/.bin/tsc -p examples/tsconfig.json
node .example-build/typescript/generate.js
# After a timeout or restart, keep the same state and run:
node .example-build/typescript/resume.js
```

`generate` refuses to overwrite `.vocloner-operation.json`. The file contains only recovery IDs and
the operation key, never the API key, text or audio. It is ignored by Git and created
owner-readable/writable. Select a different `VOCLONER_OPERATION_FILE` for a genuinely new operation.
Keep the state and input unchanged when retrying. `vocloner.mp3` is never overwritten. For large
audio use `assets.stream` and Node's `Readable.fromWeb`/`pipeline` instead of buffering.

`generate` no sobrescribe `.vocloner-operation.json`. Conserva ese archivo e input para recuperar la
misma operación con `resume`. Otra operación usa un archivo y clave nuevos, explícitamente. El
estado no incluye secretos API, texto ni audio. `vocloner.mp3` tampoco se sobrescribe. Para audio
grande usa streams.
