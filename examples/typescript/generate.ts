import { writeFile } from 'node:fs/promises'
import { VoclonerError } from '@vocloner/sdk'
import { client, required, sampleText, saveState } from './state.js'

// Executing this example calls the configured service and consumes real quota.
const vocloner = client()
const state = {
  idempotencyKey: required('VOCLONER_IDEMPOTENCY_KEY'),
  voiceId: required('VOCLONER_VOICE_ID'),
}
await saveState(state, true)
try {
  const job = await vocloner.speech.create(
    { voice_id: state.voiceId, text: sampleText, format: 'mp3' },
    { idempotencyKey: state.idempotencyKey },
  )
  await saveState({ ...state, jobId: job.id })
  const completed = await vocloner.jobs.wait(job)
  if (!completed.result || !('asset_id' in completed.result))
    throw new Error('The completed job has no speech asset.')
  await writeFile('vocloner.mp3', await vocloner.assets.download(completed.result.asset_id), {
    flag: 'wx',
    mode: 0o600,
  })
  console.log('Audio saved. Keep the recovery state to avoid generating the same operation again.')
} catch (error) {
  if (error instanceof VoclonerError) {
    if (error.jobId) await saveState({ ...state, jobId: error.jobId })
    console.error({ code: error.code, requestId: error.requestId, jobId: error.jobId })
  }
  process.exitCode = 1
}
