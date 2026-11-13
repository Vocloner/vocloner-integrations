import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { Vocloner } from '@vocloner/sdk'

export type RecoveryState = {
  idempotencyKey: string
  voiceId: string
  jobId?: string
}

export const statePath = process.env.VOCLONER_OPERATION_FILE ?? '.vocloner-operation.json'

export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name} in your server environment.`)
  return value
}

export function client(): Vocloner {
  return new Vocloner({
    apiKey: required('VOCLONER_API_KEY'),
    ...(process.env.VOCLONER_API_URL ? { baseURL: process.env.VOCLONER_API_URL } : {}),
  })
}

export async function saveState(state: RecoveryState, initial = false): Promise<void> {
  if (initial) {
    // Refuse to overwrite the recovery record of another operation.
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    return
  }
  const temporary = `${statePath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, statePath)
}

export async function loadState(): Promise<RecoveryState> {
  const value: unknown = JSON.parse(await readFile(statePath, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('idempotencyKey' in value) ||
    typeof value.idempotencyKey !== 'string' ||
    !('voiceId' in value) ||
    typeof value.voiceId !== 'string' ||
    ('jobId' in value && typeof value.jobId !== 'string')
  )
    throw new Error('The recovery state is invalid.')
  return value as RecoveryState
}

// Retrying before jobId exists must use this identical input, not edited text.
export const sampleText = 'Hello from Vocloner.'
