import { writeFile } from 'node:fs/promises'
import { VoclonerError } from '@vocloner/sdk'
import { client, loadState, sampleText, saveState } from './state.js'

const vocloner = client()
const state = await loadState()
try {
  // If no response was received, replay exactly the same request and key.
  const job =
    state.jobId ??
    (await vocloner.speech.create(
      { voice_id: state.voiceId, text: sampleText, format: 'mp3' },
      { idempotencyKey: state.idempotencyKey },
    ))
  const id = typeof job === 'string' ? job : job.id
  await saveState({ ...state, jobId: id })
  const completed = await vocloner.jobs.wait(job)
  if (!completed.result || !('asset_id' in completed.result))
    throw new Error('The completed job has no speech asset.')
  await writeFile('vocloner.mp3', await vocloner.assets.download(completed.result.asset_id), {
    flag: 'wx',
    mode: 0o600,
  })
  console.log('Existing operation recovered and audio saved.')
} catch (error) {
  if (error instanceof VoclonerError) {
    if (error.jobId) await saveState({ ...state, jobId: error.jobId })
    console.error({ code: error.code, requestId: error.requestId, jobId: error.jobId })
  }
  process.exitCode = 1
}
