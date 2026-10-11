import React, { useLayoutEffect, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isWebClientLocation } from '@/lib/web-client-location'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { withBrowserUploadFiles } from '@/web/preload-api/web-file-uploads'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import {
  captureFileExplorerOperationGuard,
  type FileExplorerOperationGuard
} from './file-explorer-operation-owner'

type Props = {
  worktreeId: string | null
  worktreePath: string | null
  destinationDir: string | null
  operationOwner?: FileExplorerOperationOwner
  onUploaded: () => Promise<unknown>
}
type Selection = {
  worktreeId: string
  worktreePath: string
  destinationDir: string
  generation: number
  guard: FileExplorerOperationGuard
}

export function BrowserFileUploadButton({
  worktreeId,
  worktreePath,
  destinationDir,
  operationOwner,
  onUploaded
}: Props): React.JSX.Element | null {
  const input = useRef<HTMLInputElement>(null)
  const selected = useRef<Selection | null>(null)
  const generation = useRef(0)
  const [busy, setBusy] = useState(false)
  useLayoutEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [worktreeId, worktreePath, destinationDir])

  if (
    !isWebClientLocation() ||
    !worktreeId ||
    !worktreePath ||
    !destinationDir ||
    operationOwner?.kind !== 'runtime'
  ) {
    return null
  }
  const label = busy
    ? translate('components.browserFileUpload.uploading', 'Uploading files…')
    : translate('components.browserFileUpload.upload', 'Upload files')
  const pick = (): void => {
    try {
      selected.current = {
        worktreeId,
        worktreePath,
        destinationDir,
        generation: generation.current,
        guard: captureFileExplorerOperationGuard(worktreeId, operationOwner)
      }
      input.current?.click()
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Upload destination is unavailable'))
    }
  }
  const upload = async (files: File[]): Promise<void> => {
    const selection = selected.current
    selected.current = null
    if (files.length === 0) {
      return
    }
    const assertCurrent = (): void => {
      if (!selection || selection.generation !== generation.current) {
        throw new Error('Upload destination changed; select the files again')
      }
      selection.guard.assertCurrent()
    }
    setBusy(true)
    try {
      assertCurrent()
      if (!selection) {
        return
      }
      const { results } = await withBrowserUploadFiles(
        files,
        (paths) =>
          importExternalPathsToRuntime(
            {
              ...selection.guard.route,
              worktreeId: selection.worktreeId,
              worktreePath: selection.worktreePath
            },
            paths,
            selection.destinationDir,
            { assertCurrent }
          ),
        assertCurrent
      )
      const imported = results.filter((result) => result.status === 'imported')
      const failed = results.filter((result) => result.status !== 'imported')
      if (imported.length > 0) {
        toast.success(
          translate('components.browserFileUpload.uploaded', 'Uploaded {{count}} file(s)', {
            count: imported.length
          })
        )
      }
      if (failed.length > 0) {
        toast.error(
          translate('components.browserFileUpload.failed', 'Could not upload {{count}} file(s)', {
            count: failed.length
          }),
          { description: failed[0].reason }
        )
      }
      if (selection.generation === generation.current) {
        await onUploaded()
      }
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Failed to upload files'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={translate('components.browserFileUpload.files', 'Files to upload')}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void upload(files)
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label={label}
            disabled={busy}
            onClick={pick}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
