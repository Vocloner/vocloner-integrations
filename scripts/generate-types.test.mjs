import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { generateTypes, runGenerator } from './generate-types.mjs'

const rootDirectory = fileURLToPath(new URL('../', import.meta.url))
const speech = {
  type: 'object',
  properties: { text: { type: 'string' }, format: { type: 'string', enum: ['mp3', 'wav'] } },
  required: ['text'],
  additionalProperties: false,
}

function contract(schemas = {}) {
  return {
    openapi: '3.1.1',
    components: { schemas },
    paths: {
      '/speech': {
        post: { requestBody: { content: { 'application/json': { schema: speech } } } },
      },
    },
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vocloner-contract-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function fixture(t) {
  const rootDirectory = await temporaryDirectory(t)
  await mkdir(path.join(rootDirectory, 'contracts'))
  const openapi = JSON.stringify(contract({ Name: { type: 'string' } }))
  const postman = JSON.stringify({ info: { name: 'Synthetic public contract' } })
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  await Promise.all([
    writeFile(path.join(rootDirectory, 'contracts/openapi.json'), openapi),
    writeFile(path.join(rootDirectory, 'contracts/postman.json'), postman),
    writeFile(
      path.join(rootDirectory, 'contracts/provenance.json'),
      JSON.stringify({
        api_version: 'v1',
        openapi_version: '3.1.1',
        sha256: hash(openapi),
        postman_sha256: hash(postman),
      }),
    ),
  ])
  return rootDirectory
}

test('generates deterministic sorted public types, required input and nullable union shapes', () => {
  const schema = contract({
    Z: { type: ['string', 'null'] },
    A: {
      type: 'object',
      properties: { optional: { type: 'boolean' }, required: { type: 'integer' } },
      required: ['required'],
      additionalProperties: false,
    },
  })
  const result = generateTypes(schema)
  assert.equal(result, generateTypes(schema))
  assert.ok(result.indexOf('export type A') < result.indexOf('export type Z'))
  assert.match(result, /"optional"\?: boolean/)
  assert.match(result, /"required": number/)
  assert.match(result, /export type Z = \(string \| null\)/)
  assert.match(result, /export type SpeechRequest/)
  assert.match(result, /"format"\?: "mp3" \| "wav"/)
  assert.match(result, /DO NOT EDIT/)
})

test('supports local references, anyOf, oneOf, allOf, nullable, dictionaries and boolean schemas', () => {
  const result = generateTypes(
    contract({
      A: { type: 'string' },
      Reference: { $ref: '#/components/schemas/A' },
      Nullable: { $ref: '#/components/schemas/A', nullable: true },
      Union: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      One: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      Both: { allOf: [{ $ref: '#/components/schemas/A' }, { type: 'string' }] },
      Dictionary: { type: 'object', additionalProperties: { type: 'string' } },
      Values: { type: 'array', items: { type: ['string', 'null'], enum: ['a', null] } },
      Unknown: true,
      Never: false,
    }),
  )
  assert.match(result, /export type Reference = A/)
  assert.match(result, /export type Nullable = \(A \| null\)/)
  assert.match(result, /export type Union = \(number \| null\)/)
  assert.match(result, /export type One = \(string \| number\)/)
  assert.match(result, /export type Both = \(A & string\)/)
  assert.match(result, /\[key: string\]: string/)
  assert.match(result, /export type Values = Array<"a" \| null>/)
  assert.match(result, /export type Unknown = unknown/)
  assert.match(result, /export type Never = never/)
})

test('rejects unsupported or ambiguous constructs with a schema location', () => {
  for (const schema of [
    { type: 'object', patternProperties: { '^x': { type: 'string' } } },
    { type: 'array', prefixItems: [{ type: 'string' }] },
    { not: { type: 'string' } },
    { $ref: 'https://example.invalid/schema' },
    { $ref: '#/components/schemas/Missing' },
    { $ref: '#/components/schemas/Bad', minLength: 3 },
    { anyOf: [{ type: 'string' }], type: 'number' },
    { type: 'object', required: ['missing'], additionalProperties: false },
    {
      type: 'object',
      properties: { id: { type: 'number' } },
      additionalProperties: { type: 'string' },
    },
    { type: 'string', const: {} },
    { type: 'string', const: 'x', enum: 123 },
    { type: 'string', enum: [1] },
    { type: ['string', 'unsupported'] },
  ]) {
    assert.throws(
      () => generateTypes(contract({ Bad: schema })),
      /Cannot generate components.schemas.Bad:/,
    )
  }
  assert.throws(() => generateTypes({ ...contract(), openapi: '3.0.0' }), /OpenAPI 3.1.1/)
  assert.throws(() => generateTypes(contract({ default: { type: 'string' } })), /identifier/)
})

test('check verifies both snapshot hashes and detects stale or missing generated types', async (t) => {
  const directory = await fixture(t)
  const run = (check) => runGenerator({ rootDirectory: directory, check })
  await assert.rejects(run(true), /stale/)
  await run(false)
  await run(true)
  const output = path.join(directory, 'packages/sdk/src/generated/types.ts')
  await writeFile(output, (await readFile(output, 'utf8')) + '// changed\n')
  await assert.rejects(run(true), /stale/)
  await writeFile(path.join(directory, 'contracts/postman.json'), '{}')
  await assert.rejects(run(false), /Postman provenance hash mismatch/)
})

test('refuses to regenerate a changed OpenAPI snapshot without matching provenance', async (t) => {
  const directory = await fixture(t)
  await writeFile(path.join(directory, 'contracts/openapi.json'), JSON.stringify(contract()))
  await assert.rejects(
    runGenerator({ rootDirectory: directory }),
    /OpenAPI provenance hash mismatch/,
  )
})

test('the committed snapshot and generated types are current', async () => {
  await runGenerator({ rootDirectory, check: true })
})

test('importing the standalone generator without contracts has no CLI side effects', async (t) => {
  const directory = await temporaryDirectory(t)
  const destination = path.join(directory, 'generate-types.mjs')
  await writeFile(destination, await readFile(new URL('./generate-types.mjs', import.meta.url)))
  const standalone = await import(pathToFileURL(destination).href)
  assert.equal(typeof standalone.generateTypes, 'function')
  assert.equal(typeof standalone.runGenerator, 'function')
  assert.deepEqual(await readdir(directory), ['generate-types.mjs'])
})

test('generated DTOs preserve required inputs, literal values, optional fields and nullable outputs in TypeScript', async (t) => {
  const directory = await temporaryDirectory(t)
  const source = await readFile(
    path.join(rootDirectory, 'packages/sdk/src/generated/types.ts'),
    'utf8',
  )
  const assertions = `
const request: SpeechRequest = { voice_id: 'synthetic-id', text: 'Hello' }
const requestWithFormat: SpeechRequest = { ...request, format: 'wav' }
// @ts-expect-error Missing required text.
const missingInput: SpeechRequest = { voice_id: 'synthetic-id' }
// @ts-expect-error Format is an API literal union.
const invalidFormat: SpeechRequest = { ...request, format: 'ogg' }
const nullableResult: Job['result'] = null
const validStatus: Job['status'] = 'reconciling'
// @ts-expect-error Unknown status must not be widened to string.
const invalidStatus: Job['status'] = 'ready'
const optionalVoiceFields: Voice = { id: 'synthetic-id', name: 'Demo', visibility: 'private', language: 'en', category: 'voice', status: 'ready' }
// @ts-expect-error Name remains required.
const invalidVoice: Voice = { id: 'synthetic-id', visibility: 'private', language: 'en', category: 'voice', status: 'ready' }
`
  const destination = path.join(directory, 'generated.ts')
  await writeFile(destination, source + assertions)
  const program = ts.createProgram([destination], {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })
  assert.ok(program.getSourceFile(destination), 'TypeScript must load the generated source')
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => directory,
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  )
})
