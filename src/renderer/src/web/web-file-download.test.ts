// @vitest-environment happy-dom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from './web-preload-api-test-harness'

describe('web workspace file downloads', () => {
  const downloads: { name: string; blob: Blob }[] = []
  const blobs = new Map<string, Blob>()

  beforeEach(() => {
    vi.resetModules()
    downloads.length = 0
    blobs.clear()
    vi.stubGlobal('Blob', NodeBlob)
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (!('arrayBuffer' in blob)) {
        throw new Error('Expected a file Blob')
      }
      const url = `blob:download-${blobs.size}`
      blobs.set(url, blob)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      blobs.delete(url)
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      const blob = blobs.get(this.href)
      if (!blob) {
        throw new Error('Missing download bytes')
      }
      downloads.push({ name: this.download, blob })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('saves UTF-8 and binary preview downloads without changing their bytes', async () => {
    const { api } = await installApi('Linux')
    await api.fs.saveDownloadedFile({
      suggestedName: 'hello.txt',
      content: 'Hello 🌊',
      encoding: 'utf8'
    })
    await api.fs.saveDownloadedFile({
      suggestedName: 'bytes.bin',
      content: 'AP8BgA==',
      encoding: 'base64'
    })
    expect(downloads.map((d) => d.name)).toEqual(['hello.txt', 'bytes.bin'])
    expect(await downloads[0].blob.text()).toBe('Hello 🌊')
    expect([...new Uint8Array(await downloads[1].blob.arrayBuffer())]).toEqual([0, 255, 1, 128])
  })

  it('publishes complete ordered chunks only after finish and releases download URLs', async () => {
    const { api } = await installApi('Linux')
    vi.useFakeTimers()
    const transfer = await api.fs.startDownloadedFile({ suggestedName: '../file.bin' })
    if (transfer.canceled) {
      throw new Error('Unexpected cancel')
    }
    await api.fs.appendDownloadedFileChunk({
      transferId: transfer.transferId,
      contentBase64: 'AP8='
    })
    await api.fs.appendDownloadedFileChunk({
      transferId: transfer.transferId,
      contentBase64: 'AYI='
    })
    expect(downloads).toHaveLength(0)
    await api.fs.finishDownloadedFile({ transferId: transfer.transferId })
    expect(downloads[0].name).toBe('file.bin')
    expect([...new Uint8Array(await downloads[0].blob.arrayBuffer())]).toEqual([0, 255, 1, 130])
    await expect(api.fs.finishDownloadedFile({ transferId: transfer.transferId })).rejects.toThrow()
    await vi.runAllTimersAsync()
    expect(blobs.size).toBe(0)
    expect(document.querySelectorAll('a')).toHaveLength(0)
  })

  it('cancels one transfer without affecting another, including an empty file', async () => {
    const { api } = await installApi('Linux')
    const canceled = await api.fs.startDownloadedFile({ suggestedName: 'cancel.bin' })
    const empty = await api.fs.startDownloadedFile({ suggestedName: 'empty.txt' })
    if (canceled.canceled || empty.canceled) {
      throw new Error('Unexpected cancel')
    }
    await api.fs.appendDownloadedFileChunk({
      transferId: canceled.transferId,
      contentBase64: 'AP8='
    })
    await api.fs.cancelDownloadedFile({ transferId: canceled.transferId })
    await api.fs.cancelDownloadedFile({ transferId: canceled.transferId })
    await expect(
      api.fs.appendDownloadedFileChunk({ transferId: canceled.transferId, contentBase64: 'AQ==' })
    ).rejects.toThrow()
    await expect(api.fs.finishDownloadedFile({ transferId: canceled.transferId })).rejects.toThrow()
    await api.fs.finishDownloadedFile({ transferId: empty.transferId })
    expect(downloads.map((d) => [d.name, d.blob.size])).toEqual([['empty.txt', 0]])
  })
  it('abandons malformed transfers and still accepts a subsequent download', async () => {
    const { api } = await installApi('Linux')
    const transfer = await api.fs.startDownloadedFile({ suggestedName: 'bad.bin' })
    if (transfer.canceled) {
      throw new Error('Unexpected cancel')
    }
    await api.fs.appendDownloadedFileChunk({
      transferId: transfer.transferId,
      contentBase64: 'AP8='
    })
    await expect(
      api.fs.appendDownloadedFileChunk({ transferId: transfer.transferId, contentBase64: '!!!' })
    ).rejects.toThrow()
    await expect(api.fs.finishDownloadedFile({ transferId: transfer.transferId })).rejects.toThrow()
    await api.fs.saveDownloadedFile({
      suggestedName: 'good.txt',
      content: 'complete',
      encoding: 'utf8'
    })
    expect(downloads.map((d) => d.name)).toEqual(['good.txt'])
    expect(await downloads[0].blob.text()).toBe('complete')
  })

  it('releases a failed browser handoff without leaving a reusable transfer', async () => {
    const { api } = await installApi('Linux')
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new Error('Download blocked')
    })
    const transfer = await api.fs.startDownloadedFile({ suggestedName: 'blocked.txt' })
    if (transfer.canceled) {
      throw new Error('Unexpected cancel')
    }
    await api.fs.appendDownloadedFileChunk({
      transferId: transfer.transferId,
      contentBase64: 'AQ=='
    })
    await expect(api.fs.finishDownloadedFile({ transferId: transfer.transferId })).rejects.toThrow(
      'Download blocked'
    )
    expect(blobs.size).toBe(0)
    expect(document.querySelectorAll('a')).toHaveLength(0)
    await expect(api.fs.finishDownloadedFile({ transferId: transfer.transferId })).rejects.toThrow()
    await api.fs.saveDownloadedFile({
      suggestedName: 'retry.txt',
      content: 'retry',
      encoding: 'utf8'
    })
    expect(downloads.map((d) => d.name)).toEqual(['retry.txt'])
  })
})
