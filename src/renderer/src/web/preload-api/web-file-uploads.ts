import type { PreloadApi } from '../../../../preload/api-types'
import type { StageRuntimeUploadResult } from '../../../../shared/runtime-upload-staging-contract'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { blobToBase64 } from '@/lib/image-blob-png'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { createRuntimeImportSessionGuard } from '@/runtime/runtime-file-mutation-rpc'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import {
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from '../../../../shared/runtime-import-limits'

type UploadApi = Pick<
  PreloadApi['fs'],
  'stageExternalPathsForRuntimeUpload' | 'uploadExternalFileToRuntime'
>
const selectedFiles = new Map<string, { file: File; assertCurrent: () => void }>()
const SLICE_BYTES = 384 * 1024

/** File handles exist only for the lifetime of this explicit browser selection. */
export async function withBrowserUploadFiles<T>(
  files: readonly File[],
  action: (paths: string[]) => Promise<T>,
  assertCurrent: () => void = () => {}
): Promise<T> {
  assertCurrent()
  if (files.length > NATIVE_FILE_DROP_MAX_PATHS) {
    throw new Error('Select no more than 256 files at a time')
  }
  let total = 0
  for (const file of files) {
    if (!file.name || file.name === '.' || file.name === '..' || /[\\/\p{Cc}]/u.test(file.name)) {
      throw new Error('Invalid upload filename')
    }
    if (file.size > REMOTE_IMPORT_MAX_FILE_BYTES) {
      throw new Error('A file exceeds the 2 GiB upload limit')
    }
    total += file.size
  }
  if (total > REMOTE_IMPORT_MAX_TOTAL_BYTES) {
    throw new Error('The selected files exceed the 8 GiB upload limit')
  }
  const paths = files.map((file) => {
    const path = `browser-upload:${createBrowserUuid()}`
    selectedFiles.set(path, { file, assertCurrent })
    return path
  })
  try {
    return await action(paths)
  } finally {
    for (const path of paths) {
      selectedFiles.delete(path)
    }
  }
}

function requireFile(path: string): File {
  const source = selectedFiles.get(path)
  if (!source) {
    throw new Error('Select the file again before uploading')
  }
  source.assertCurrent()
  return source.file
}

export function createWebFileUploads(): UploadApi {
  return {
    stageExternalPathsForRuntimeUpload: async ({ sourcePaths }) => {
      const sources: StageRuntimeUploadResult['sources'] = sourcePaths.map((sourcePath) => {
        try {
          const file = requireFile(sourcePath)
          return {
            sourcePath,
            status: 'staged',
            name: file.name,
            kind: 'file',
            entries: [
              {
                relativePath: '',
                kind: 'file',
                byteLength: file.size,
                modifiedAtMs: file.lastModified,
                inode: 0,
                deviceId: 0
              }
            ]
          }
        } catch (error) {
          return {
            sourcePath,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error)
          }
        }
      })
      return { sources }
    },
    uploadExternalFileToRuntime: async (args) => {
      const file = requireFile(args.sourceRootPath)
      if (
        args.entryRelativePath ||
        file.size !== args.expected.byteLength ||
        file.lastModified !== args.expected.modifiedAtMs ||
        args.expected.inode !== 0 ||
        args.expected.deviceId !== 0
      ) {
        throw new Error('Upload source changed since selection')
      }
      if (!args.expectedEnvironmentRuntimeId || !args.expectedExecutionHostId) {
        throw new Error('Upload destination ownership is unavailable')
      }
      const revision = captureRuntimeEnvironmentRequestRevision(
        args.environmentId,
        args.expectedEnvironmentPairingRevision
      )
      const assertCurrent = createRuntimeImportSessionGuard(
        args.environmentId,
        revision,
        getRuntimeEnvironmentConnectionGeneration(args.environmentId)
      )
      let offset = 0
      do {
        assertCurrent()
        requireFile(args.sourceRootPath)
        const chunk = file.slice(offset, offset + SLICE_BYTES)
        const contentBase64 = await blobToBase64(chunk)
        assertCurrent()
        requireFile(args.sourceRootPath)
        await callRuntimeRpc(
          { kind: 'environment', environmentId: args.environmentId },
          'files.writeBase64Chunk',
          {
            worktree: args.worktree,
            relativePath: args.relativePath,
            contentBase64,
            append: offset > 0,
            expectedExecutionHostId: args.expectedExecutionHostId,
            expectedSshTargetId: args.expectedSshTargetId,
            expectedSshConnectionGeneration: args.expectedSshConnectionGeneration
          },
          {
            timeoutMs: 30_000,
            expectedEnvironmentPairingRevision: revision,
            expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId
          }
        )
        offset += chunk.size
      } while (offset < file.size)
      return { byteLength: file.size }
    }
  }
}
