// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserFileUploadButton } from './BrowserFileUploadButton'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({
  importFiles: vi.fn(),
  assertCurrent: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importFiles
}))
vi.mock('./file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: () => ({
    route: {
      target: { kind: 'environment', environmentId: 'server' },
      expectedExecutionHostId: 'local'
    },
    assertCurrent: mocks.assertCurrent
  })
}))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
const refresh = vi.fn().mockResolvedValue(undefined)
const props = {
  worktreeId: 'wt',
  worktreePath: '/repo',
  destinationDir: '/repo/src',
  operationOwner: {
    kind: 'runtime' as const,
    environmentId: 'server',
    executionHostId: 'runtime:server' as const
  },
  onUploaded: refresh
}
function view(next: React.ComponentProps<typeof BrowserFileUploadButton> = props) {
  return (
    <TooltipProvider>
      <BrowserFileUploadButton {...next} />
    </TooltipProvider>
  )
}
beforeEach(() => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  mocks.importFiles
    .mockReset()
    .mockResolvedValue({ results: [{ status: 'imported', destPath: '/repo/src/a.txt' }] })
  mocks.assertCurrent.mockReset()
  mocks.success.mockReset()
  mocks.error.mockReset()
  refresh.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Explorer browser upload picker', () => {
  it('uploads selected files to the displayed folder and refreshes it', async () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }))
    fireEvent.change(screen.getByLabelText('Files to upload'), {
      target: { files: [new File(['hello'], 'a.txt')] }
    })
    await waitFor(() => expect(mocks.importFiles).toHaveBeenCalledTimes(1))
    expect(mocks.importFiles.mock.calls[0][0]).toMatchObject({
      target: { kind: 'environment', environmentId: 'server' },
      worktreeId: 'wt',
      worktreePath: '/repo',
      expectedExecutionHostId: 'local'
    })
    expect(mocks.importFiles.mock.calls[0][2]).toBe('/repo/src')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(mocks.success).toHaveBeenCalled()
  })

  it('refuses a selection after the user changes the destination folder', async () => {
    const { rerender } = render(view())
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }))
    rerender(view({ ...props, destinationDir: '/repo/other' }))
    fireEvent.change(screen.getByLabelText('Files to upload'), {
      target: { files: [new File(['hello'], 'a.txt')] }
    })
    await act(async () => {})
    expect(mocks.importFiles).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalled()
  })

  it('does not expose a picker for desktop or unresolved owners', () => {
    const { rerender } = render(view({ ...props, operationOwner: undefined }))
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    rerender(view())
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
  })
})
