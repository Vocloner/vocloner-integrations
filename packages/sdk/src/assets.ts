import { VoclonerError, positiveInteger, validateId } from './errors.js'
import type { RequestOptions, Transport } from './transport.js'

export interface DownloadOptions extends RequestOptions {
  /** Enforced for both streams and buffered downloads. Default: 64 MiB. */
  maxBytes?: number
}

export class Assets {
  readonly #transport: Transport
  constructor(transport: Transport) {
    this.#transport = transport
  }

  async stream(id: string, options: DownloadOptions = {}): Promise<ReadableStream<Uint8Array>> {
    validateId(id)
    const maxBytes = positiveInteger(options.maxBytes ?? 64 * 1024 * 1024, 'maxBytes')
    const opened = await this.#transport.open(`assets/${id}/content`, options)
    const { response, deadline, metadata } = opened
    const type = response.headers.get('content-type')?.toLowerCase()
    const lengthHeader = response.headers.get('content-length')
    const length = lengthHeader === null ? undefined : Number(lengthHeader)
    if (
      !type?.startsWith('audio/') ||
      !response.body ||
      (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
    ) {
      void response.body?.cancel().catch(() => {})
      deadline.dispose()
      throw new VoclonerError(
        'invalid_response',
        'The download is not a valid audio response.',
        metadata,
      )
    }
    if (length !== undefined && length > maxBytes) {
      void response.body.cancel().catch(() => {})
      deadline.dispose()
      throw new VoclonerError('download_too_large', 'The audio exceeds maxBytes.', metadata)
    }
    const reader = response.body.getReader()
    let size = 0
    let closed = false
    let onAbort: () => void
    const cleanup = () => {
      closed = true
      deadline.signal.removeEventListener('abort', onAbort)
      deadline.dispose()
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        onAbort = () => {
          if (closed) return
          cleanup()
          void reader.cancel().catch(() => {})
          controller.error(deadline.error().withContext(metadata))
        }
        deadline.signal.addEventListener('abort', onAbort, { once: true })
        if (deadline.signal.aborted) onAbort()
      },
      async pull(controller) {
        if (closed) return
        try {
          const { done, value } = await deadline.run(reader.read())
          if (closed) return
          if (done) {
            if (length !== undefined && size !== length)
              throw new VoclonerError(
                'download_incomplete',
                'The audio download ended before its declared size.',
                metadata,
              )
            cleanup()
            reader.releaseLock()
            controller.close()
            return
          }
          size += value.byteLength
          if (size > maxBytes)
            throw new VoclonerError('download_too_large', 'The audio exceeds maxBytes.', metadata)
          controller.enqueue(value)
        } catch (error) {
          if (closed) return
          cleanup()
          void reader.cancel().catch(() => {})
          const safe = deadline.signal.aborted
            ? deadline.error()
            : error instanceof VoclonerError
              ? error
              : new VoclonerError(
                  'download_interrupted',
                  'The audio download was interrupted. Request it again by asset ID.',
                  { retryable: true },
                )
          controller.error(safe.withContext(metadata))
        }
      },
      async cancel() {
        if (closed) return
        closed = true
        // Keep the deadline and upstream AbortSignal alive until cancel settles.
        deadline.signal.removeEventListener('abort', onAbort)
        try {
          await deadline.run(reader.cancel())
        } catch {
          throw (
            deadline.signal.aborted
              ? deadline.error()
              : new VoclonerError(
                  'download_interrupted',
                  'The audio stream could not be closed cleanly.',
                  { retryable: true },
                )
          ).withContext(metadata)
        } finally {
          cleanup()
          reader.releaseLock()
        }
      },
    })
  }

  async download(id: string, options: DownloadOptions = {}): Promise<Uint8Array> {
    const stream = await this.stream(id, options)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.byteLength
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    } finally {
      reader.releaseLock()
    }
  }
}
