import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vocloner-package-'))
const npm = process.env.npm_execpath
assert.ok(npm, 'Run through npm run pack:check or npm run check.')
const runNpm = (args, cwd = root) =>
  execFileSync(process.execPath, [npm, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: path.join(temporary, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

try {
  const packed = runNpm([
    'pack',
    '--workspace',
    '@vocloner/sdk',
    '--json',
    '--pack-destination',
    temporary,
  ])
  assert.ok(
    packed.trim(),
    'npm pack returned no metadata. This check requires permission to create local child processes.',
  )
  const records = JSON.parse(packed)
  const record = records[0]
  assert.ok(record && records.length === 1, 'Expected one SDK package.')
  const files = record.files.map((file) => file.path)
  for (const file of files) {
    assert.ok(
      file.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(file),
      `Unexpected package file: ${file}`,
    )
    if (file.startsWith('dist/')) {
      const text = await readFile(path.join(root, 'packages/sdk', file), 'utf8')
      assert.doesNotMatch(
        text,
        /(?:@\/lib\/|server-only|SUPABASE_SERVICE_ROLE_KEY|FISH_CONFIG_ENCRYPTION_KEY)/,
      )
    }
  }
  assert.ok(files.includes('dist/index.d.ts') && files.includes('dist/webhooks.js'))
  const manifest = JSON.parse(await readFile(path.join(root, 'packages/sdk/package.json'), 'utf8'))
  assert.equal(
    Object.keys(manifest.dependencies ?? {}).length,
    0,
    'The beta has no runtime dependencies.',
  )
  await writeFile(
    path.join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  )
  runNpm(
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(temporary, record.filename),
    ],
    temporary,
  )
  await writeFile(
    path.join(temporary, 'smoke.mjs'),
    `
import assert from 'node:assert/strict'
import { Vocloner, VoclonerError } from '@vocloner/sdk'
import { verifyWebhook, parseWebhook } from '@vocloner/sdk/webhooks'
assert.equal(typeof verifyWebhook, 'function')
assert.equal(typeof parseWebhook, 'function')
assert.equal(verifyWebhook(new Uint8Array(), '', ''), false)
assert.equal(new VoclonerError('test_error', 'Test').code, 'test_error')
let calls = 0
const client = new Vocloner({apiKey:'vcl_api_SYNTHETIC_PACKAGE_TEST', fetch: async (url, init) => {
  calls++
  assert.equal(new URL(url).origin, 'https://api.vocloner.org')
  assert.equal(init.redirect, 'error')
  return new Response(JSON.stringify({items:[],next_cursor:null}), {headers:{'Content-Type':'application/json'}})
}})
assert.deepEqual(await client.voices.list(), {items:[],next_cursor:null})
assert.equal(calls, 1)
`,
  )
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: temporary, stdio: 'pipe' })
  await writeFile(
    path.join(temporary, 'consumer.mts'),
    `
import { Vocloner, type Job, type SpeechRequest } from '@vocloner/sdk'
import { verifyWebhook } from '@vocloner/sdk/webhooks'
const client = new Vocloner({apiKey:'synthetic'})
const speech: SpeechRequest = {voice_id:'id',text:'hello'}
const job: Promise<Job> = client.speech.create(speech, {idempotencyKey:'stable'})
// @ts-expect-error A stable key is required for speech.
client.speech.create(speech)
// @ts-expect-error Audio format is restricted by the contract.
const bad: SpeechRequest = {voice_id:'id',text:'hello',format:'ogg'}
void job; void bad; void verifyWebhook
`,
  )
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--lib',
      'ES2022,DOM,DOM.Iterable',
      path.join(temporary, 'consumer.mts'),
    ],
    { cwd: temporary, stdio: 'pipe' },
  )
  console.log(
    `Package checked: ${files.length} allowed files; isolated offline install, imports, mock request and consumer types passed.`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
