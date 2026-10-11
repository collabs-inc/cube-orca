// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { createWebFileUploads, withBrowserUploadFiles } from './preload-api/web-file-uploads'

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: call }))

beforeEach(() => {
  call.mockReset().mockResolvedValue({})
  replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 1 }])
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function upload(files: File[], action?: (paths: string[]) => Promise<void>): Promise<void> {
  await withBrowserUploadFiles(files, async (paths) => {
    if (action) {
      return action(paths)
    }
    const api = createWebFileUploads()
    const staged = await api.stageExternalPathsForRuntimeUpload({ sourcePaths: paths })
    for (const source of staged.sources) {
      if (source.status !== 'staged') {
        throw new Error('Expected staged file')
      }
      const entry = source.entries[0]
      if (entry.kind !== 'file') {
        throw new Error('Expected file entry')
      }
      await api.uploadExternalFileToRuntime({
        environmentId: 'server',
        sourceRootPath: source.sourcePath,
        entryRelativePath: '',
        expected: entry,
        worktree: 'id:wt',
        relativePath: '.upload-temp',
        expectedExecutionHostId: 'local',
        expectedEnvironmentPairingRevision: 1,
        expectedEnvironmentRuntimeId: 'runtime-1'
      })
    }
  })
}

describe('browser selected file uploads', () => {
  it('stages only selected files and releases access after the operation', async () => {
    const api = createWebFileUploads()
    let captured: string[] = []
    await upload([new File(['hello'], 'hello.txt', { lastModified: 10 })], async (paths) => {
      captured = paths
      const result = await api.stageExternalPathsForRuntimeUpload({ sourcePaths: paths })
      expect(result.sources).toMatchObject([
        {
          status: 'staged',
          name: 'hello.txt',
          entries: [{ kind: 'file', byteLength: 5, modifiedAtMs: 10 }]
        }
      ])
      expect(
        (await api.stageExternalPathsForRuntimeUpload({ sourcePaths: ['/etc/passwd'] })).sources
      ).toMatchObject([{ status: 'failed' }])
    })
    expect(
      (await api.stageExternalPathsForRuntimeUpload({ sourcePaths: captured })).sources
    ).toMatchObject([{ status: 'failed' }])
  })

  it('streams exact binary bytes in bounded chunks with all runtime and owner guards', async () => {
    const bytes = Uint8Array.from({ length: 800000 }, (_, index) => index % 256)
    await upload([new File([bytes], 'bytes.bin')])
    expect(call.mock.calls.length).toBeGreaterThan(1)
    const actual = Buffer.concat(
      call.mock.calls.map(([target, method, params, options], index) => {
        expect(target).toEqual({ kind: 'environment', environmentId: 'server' })
        expect(method).toBe('files.writeBase64Chunk')
        expect(params).toMatchObject({
          worktree: 'id:wt',
          relativePath: '.upload-temp',
          expectedExecutionHostId: 'local',
          append: index > 0
        })
        expect(options).toMatchObject({
          expectedEnvironmentPairingRevision: 1,
          expectedEnvironmentRuntimeId: 'runtime-1'
        })
        expect(params.contentBase64.length).toBeLessThanOrEqual(512 * 1024)
        return Buffer.from(params.contentBase64, 'base64')
      })
    )
    expect(actual).toEqual(Buffer.from(bytes))
  })

  it('creates an empty upload and rejects unsafe names before any runtime write', async () => {
    await upload([new File([], 'empty.txt')])
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][2]).toMatchObject({ contentBase64: '', append: false })
    call.mockClear()
    await expect(upload([new File(['data'], '../escape.txt')])).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })

  it('aborts before another chunk when the pairing changes during an upload', async () => {
    call.mockImplementationOnce(async () => {
      replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 1, pairingRevision: 2 }])
      return {}
    })
    await expect(upload([new File([new Uint8Array(800000)], 'bytes.bin')])).rejects.toThrow(
      /pairing changed/i
    )
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('releases selected file access when the importer fails', async () => {
    let paths: string[] = []
    await expect(
      upload([new File(['data'], 'a.txt')], async (selected) => {
        paths = selected
        throw new Error('Disconnected')
      })
    ).rejects.toThrow('Disconnected')
    expect(
      (await createWebFileUploads().stageExternalPathsForRuntimeUpload({ sourcePaths: paths }))
        .sources
    ).toMatchObject([{ status: 'failed' }])
  })

  it('stops streaming when the originating picker scope becomes invalid', async () => {
    let valid = true
    call.mockImplementationOnce(async () => {
      valid = false
      return {}
    })
    const file = new File([new Uint8Array(800000)], 'bytes.bin')
    await expect(
      withBrowserUploadFiles(
        [file],
        async (paths) => {
          const api = createWebFileUploads()
          await api.uploadExternalFileToRuntime({
            environmentId: 'server',
            sourceRootPath: paths[0],
            entryRelativePath: '',
            expected: {
              byteLength: file.size,
              modifiedAtMs: file.lastModified,
              inode: 0,
              deviceId: 0
            },
            worktree: 'id:wt',
            relativePath: '.upload-temp',
            expectedExecutionHostId: 'local',
            expectedEnvironmentPairingRevision: 1,
            expectedEnvironmentRuntimeId: 'runtime-1'
          })
        },
        () => {
          if (!valid) {
            throw new Error('Picker scope changed')
          }
        }
      )
    ).rejects.toThrow('Picker scope changed')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
