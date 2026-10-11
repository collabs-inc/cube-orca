import { createBrowserUuid } from '@/lib/browser-uuid'
import type { PreloadApi } from '../../../../preload/api-types'

type DownloadApi = Pick<
  PreloadApi['fs'],
  | 'saveDownloadedFile'
  | 'startDownloadedFile'
  | 'appendDownloadedFileChunk'
  | 'finishDownloadedFile'
  | 'cancelDownloadedFile'
>

// Browser downloads retain bytes until the Blob is handed to the download manager.
const MAX_BUFFERED_BYTES = 256 * 1024 * 1024

function downloadName(name: string): string {
  return (
    name
      .split(/[\\/]/)
      .pop()
      ?.replace(/\p{Cc}/gu, '_') || 'download'
  )
}

function decodeBase64(content: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(content), (char) => char.charCodeAt(0))
}

function publishDownload(name: string, chunks: BlobPart[], release: () => void): void {
  let url: string | undefined
  const anchor = document.createElement('a')
  let started = false
  const cleanup = (): void => {
    if (url) {
      URL.revokeObjectURL(url)
    }
    release()
  }
  try {
    url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }))
    anchor.href = url
    anchor.download = name
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    started = true
  } finally {
    anchor.remove()
    // Let the browser acquire the Blob before releasing our URL reference.
    if (started) {
      setTimeout(cleanup, 60_000)
    } else {
      cleanup()
    }
  }
}

export function createWebFileDownloads(): DownloadApi {
  const transfers = new Map<string, { name: string; chunks: BlobPart[]; size: number }>()
  let bufferedBytes = 0
  const discard = (id: string): void => {
    const transfer = transfers.get(id)
    if (transfer) {
      bufferedBytes -= transfer.size
    }
    transfers.delete(id)
  }
  const requireTransfer = (id: string) => {
    const transfer = transfers.get(id)
    if (!transfer) {
      throw new Error('Download is no longer active')
    }
    return transfer
  }
  const checkCapacity = (size: number): void => {
    if (bufferedBytes + size > MAX_BUFFERED_BYTES) {
      throw new Error(
        'Browser downloads support up to 256 MiB at a time. Download a smaller file or wait for other transfers to finish.'
      )
    }
  }
  return {
    saveDownloadedFile: async ({ suggestedName, content, encoding }) => {
      const bytes =
        encoding === 'base64' ? decodeBase64(content) : new TextEncoder().encode(content)
      checkCapacity(bytes.byteLength)
      const name = downloadName(suggestedName)
      bufferedBytes += bytes.byteLength
      publishDownload(name, [bytes], () => {
        bufferedBytes -= bytes.byteLength
      })
      return { canceled: false, destinationPath: name }
    },
    startDownloadedFile: async ({ suggestedName }) => {
      const name = downloadName(suggestedName)
      const transferId = createBrowserUuid()
      transfers.set(transferId, { name, chunks: [], size: 0 })
      return { canceled: false, transferId, destinationPath: name }
    },
    appendDownloadedFileChunk: async ({ transferId, contentBase64 }) => {
      const transfer = requireTransfer(transferId)
      try {
        const bytes = decodeBase64(contentBase64)
        checkCapacity(bytes.byteLength)
        transfer.chunks.push(bytes)
        transfer.size += bytes.byteLength
        bufferedBytes += bytes.byteLength
        return { ok: true }
      } catch (error) {
        discard(transferId)
        throw error
      }
    },
    finishDownloadedFile: async ({ transferId }) => {
      const transfer = requireTransfer(transferId)
      transfers.delete(transferId)
      publishDownload(transfer.name, transfer.chunks, () => {
        bufferedBytes -= transfer.size
      })
      return { canceled: false, destinationPath: transfer.name }
    },
    cancelDownloadedFile: async ({ transferId }) => {
      discard(transferId)
      return { ok: true }
    }
  }
}
