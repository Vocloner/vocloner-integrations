import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const annotations = new Set([
  '$schema',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
])
const constraints = new Set([
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
])
const keywords = new Set([
  ...annotations,
  ...constraints,
  '$ref',
  'type',
  'enum',
  'const',
  'nullable',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf',
  'allOf',
])
const identifiers = /^[A-Za-z_$][\w$]*$/
const primitives = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])
const reservedNames = new Set(
  'any boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for function if implements import in infer instanceof interface keyof let module namespace never new null number object package private protected public readonly return static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield'.split(
    ' ',
  ),
)

function fail(location, message) {
  throw new Error(`Cannot generate ${location}: ${message}`)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function literal(value, location) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) fail(location, 'invalid number')
    return JSON.stringify(value)
  }
  fail(location, 'only scalar enum/const values are supported')
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((member) => matchesType(value, member))
  if (type === 'null') return value === null
  if (type === 'integer') return Number.isInteger(value)
  return typeof value === type
}

function checkConstraints(schema, location) {
  for (const key of constraints) {
    if (!(key in schema)) continue
    const value = schema[key]
    if (key === 'format' || key === 'pattern') {
      if (typeof value !== 'string') fail(location, `${key} must be a string`)
    } else if (key === 'uniqueItems') {
      if (typeof value !== 'boolean') fail(location, `${key} must be boolean`)
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(location, `${key} must be finite`)
    }
  }
}

/** Compile the supported JSON Schema subset. TypeScript does not validate runtime constraints. */
export function generateTypes(contract, sourceHash = '') {
  if (!isObject(contract) || contract.openapi !== '3.1.1') {
    throw new Error('Expected an OpenAPI 3.1.1 snapshot')
  }
  const schemas = contract.components?.schemas
  if (!isObject(schemas)) throw new Error('Missing components.schemas')
  const names = Object.keys(schemas).sort()
  for (const name of names) {
    if (!identifiers.test(name) || reservedNames.has(name)) {
      fail(name, 'component name is not a TypeScript identifier')
    }
    if (name === 'SpeechRequest') fail(name, 'component conflicts with request type')
  }

  function render(schema, location) {
    if (schema === true) return 'unknown'
    if (schema === false) return 'never'
    if (!isObject(schema)) fail(location, 'schema must be an object or boolean')
    for (const key of Object.keys(schema)) {
      if (!keywords.has(key)) fail(location, `unsupported keyword ${key}`)
    }
    checkConstraints(schema, location)
    if ('nullable' in schema && typeof schema.nullable !== 'boolean') {
      fail(location, 'nullable must be boolean')
    }
    if (schema.nullable) {
      const { nullable: _, ...rest } = schema
      return `(${render(rest, location)} | null)`
    }
    const shapeKeys = Object.keys(schema).filter(
      (key) => !annotations.has(key) && !constraints.has(key) && key !== 'nullable',
    )
    if ('$ref' in schema) {
      if (shapeKeys.some((key) => key !== '$ref') || [...constraints].some((k) => k in schema)) {
        fail(location, '$ref siblings with constraints are not supported')
      }
      const prefix = '#/components/schemas/'
      const reference = schema.$ref
      if (typeof reference !== 'string' || !reference.startsWith(prefix)) {
        fail(location, 'only local component references are supported')
      }
      const name = reference.slice(prefix.length)
      if (!names.includes(name)) fail(location, `unknown component reference ${reference}`)
      return name
    }
    const combinators = ['anyOf', 'oneOf', 'allOf'].filter((key) => key in schema)
    if (combinators.length) {
      const key = combinators[0]
      if (shapeKeys.length !== 1 || [...constraints].some((k) => k in schema)) {
        fail(location, 'combined schema siblings with constraints are not supported')
      }
      if (!Array.isArray(schema[key]) || !schema[key].length) {
        fail(location, `${key} must be a nonempty array`)
      }
      return `(${schema[key]
        .map((child, index) => render(child, `${location}.${key}[${index}]`))
        .join(key === 'allOf' ? ' & ' : ' | ')})`
    }
    if (
      schema.type !== undefined &&
      (Array.isArray(schema.type)
        ? !schema.type.length ||
          new Set(schema.type).size !== schema.type.length ||
          schema.type.some((type) => !primitives.has(type))
        : !primitives.has(schema.type))
    ) {
      fail(location, `unsupported type ${schema.type}`)
    }
    if ('const' in schema || 'enum' in schema) {
      if (shapeKeys.some((key) => !['type', 'enum', 'const'].includes(key))) {
        fail(location, 'enum/const schema with structural siblings is not supported')
      }
      if ('enum' in schema) {
        if (!Array.isArray(schema.enum) || !schema.enum.length) {
          fail(location, 'enum must be a nonempty array')
        }
        schema.enum.forEach((value) => literal(value, location))
      }
      const values = 'const' in schema ? [schema.const] : schema.enum
      for (const value of values) {
        literal(value, location)
        if (schema.type && !matchesType(value, schema.type)) {
          fail(location, 'enum/const value conflicts with type')
        }
        if ('const' in schema && 'enum' in schema && !schema.enum.includes(value)) {
          fail(location, 'const conflicts with enum')
        }
      }
      return values.map((value) => literal(value, location)).join(' | ')
    }
    if (Array.isArray(schema.type)) {
      return `(${schema.type.map((type) => render({ ...schema, type }, location)).join(' | ')})`
    }
    if (schema.type === undefined) {
      if (shapeKeys.length || [...constraints].some((k) => k in schema)) {
        fail(location, 'constraints without an explicit type are not supported')
      }
      return 'unknown'
    }
    const allowedStructure = new Set(['type'])
    if (schema.type === 'object') {
      ;['properties', 'required', 'additionalProperties'].forEach((key) =>
        allowedStructure.add(key),
      )
    }
    if (schema.type === 'array') allowedStructure.add('items')
    if (shapeKeys.some((key) => !allowedStructure.has(key))) {
      fail(location, `structural keyword conflicts with type ${schema.type}`)
    }
    if (schema.type === 'object') {
      const properties = schema.properties ?? {}
      if (!isObject(properties)) fail(location, 'properties must be an object')
      const required = schema.required ?? []
      if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
        fail(location, 'required must be an array of property names')
      }
      if (new Set(required).size !== required.length) fail(location, 'required contains duplicates')
      if (required.some((name) => !Object.hasOwn(properties, name))) {
        fail(location, 'required properties without a property schema are not supported')
      }
      const additional = schema.additionalProperties ?? true
      if (typeof additional !== 'boolean' && !isObject(additional)) {
        fail(location, 'additionalProperties must be a schema or boolean')
      }
      const propertyNames = Object.keys(properties).sort()
      if (typeof additional === 'object' && propertyNames.length) {
        fail(
          location,
          'typed additionalProperties with named properties cannot be represented safely',
        )
      }
      const fields = propertyNames.map(
        (name) =>
          `${JSON.stringify(name)}${required.includes(name) ? '' : '?'}: ${render(properties[name], `${location}.${name}`)};`,
      )
      if (additional !== false) {
        fields.push(
          `[key: string]: ${additional === true ? 'unknown' : render(additional, `${location}.additionalProperties`)};`,
        )
      }
      if (!fields.length) return 'Record<string, never>'
      return `{\n${fields.map((field) => `  ${field.replaceAll('\n', '\n  ')}`).join('\n')}\n}`
    }
    if (schema.type === 'array') {
      return `Array<${render(schema.items ?? true, `${location}.items`)}>`
    }
    return schema.type === 'integer' ? 'number' : schema.type
  }

  const declarations = names.map(
    (name) => `export type ${name} = ${render(schemas[name], `components.schemas.${name}`)}`,
  )
  const speech =
    contract.paths?.['/speech']?.post?.requestBody?.content?.['application/json']?.schema
  if (speech === undefined) throw new Error('Missing POST /speech JSON request schema')
  declarations.push(`export type SpeechRequest = ${render(speech, 'POST /speech request')}`)
  return [
    '// Generated by scripts/generate-types.mjs. DO NOT EDIT.',
    `// OpenAPI 3.1.1 snapshot SHA-256: ${sourceHash || '(fixture)'}`,
    '// Transport shapes only: formats, patterns, numeric bounds, defaults and exact object',
    '// keys remain server/runtime validation. oneOf exclusivity is not enforced by TypeScript.',
    '',
    declarations.join('\n\n'),
    '',
  ].join('\n')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function runGenerator({ rootDirectory, check = false }) {
  const [openapiBytes, postmanBytes, provenanceBytes] = await Promise.all([
    readFile(path.join(rootDirectory, 'contracts/openapi.json')),
    readFile(path.join(rootDirectory, 'contracts/postman.json')),
    readFile(path.join(rootDirectory, 'contracts/provenance.json'), 'utf8'),
  ])
  const contract = JSON.parse(openapiBytes.toString('utf8'))
  const provenance = JSON.parse(provenanceBytes)
  if (provenance.sha256 !== sha256(openapiBytes))
    throw new Error('OpenAPI provenance hash mismatch')
  if (provenance.postman_sha256 !== sha256(postmanBytes)) {
    throw new Error('Postman provenance hash mismatch')
  }
  if (provenance.api_version !== 'v1' || provenance.openapi_version !== contract.openapi) {
    throw new Error('Contract version does not match provenance')
  }
  const generated = generateTypes(contract, provenance.sha256)
  const destination = path.join(rootDirectory, 'packages/sdk/src/generated/types.ts')
  if (check) {
    let current
    try {
      current = await readFile(destination, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (current !== generated) {
      throw new Error('Generated contract types are stale; run npm run contracts:generate')
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, generated)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some((argument) => argument !== '--check') || args.length > 1) {
    console.error('Usage: node scripts/generate-types.mjs [--check]')
    process.exitCode = 1
  } else {
    try {
      await runGenerator({
        rootDirectory: fileURLToPath(new URL('../', import.meta.url)),
        check: args.includes('--check'),
      })
      console.log(
        args.includes('--check')
          ? 'Contract types and hashes are current.'
          : 'Contract types generated.',
      )
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Contract generation failed')
      process.exitCode = 1
    }
  }
}
