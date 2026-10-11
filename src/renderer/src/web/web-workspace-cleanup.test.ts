import { afterEach, expect, it, vi } from 'vitest'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.doUnmock('./web-runtime-client')
})

it('returns the server cleanup scan instead of the undefined desktop fallback', async () => {
  const result = { scannedAt: 123, candidates: [], errors: [] }
  const call = vi
    .fn()
    .mockResolvedValue({ id: 'scan', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const progress = vi.fn()
  expect(
    await globals.window.api.workspaceCleanup.scan(
      { includeAllWorkspaces: true, scanId: 'scan-1' },
      progress
    )
  ).toEqual(result)
  expect(call).toHaveBeenCalledWith(
    'workspaceCleanup.scan',
    { includeAllWorkspaces: true, scanId: 'scan-1' },
    expect.anything()
  )
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ candidates: [], scanId: 'scan-1' })
  )
})

it('qualifies Cube-local candidates and preserves SSH ownership and scan errors', async () => {
  const { makeCandidate } =
    await import('../components/workspace-cleanup/workspace-cleanup-presentation-fixtures')
  const result = {
    scannedAt: 1,
    candidates: [
      makeCandidate({ executionHostId: 'local' }),
      makeCandidate({ executionHostId: 'ssh:box', connectionId: 'box' })
    ],
    errors: [{ repoId: 'repo', repoName: 'repo', executionHostId: 'local', message: 'offline' }]
  }
  const call = vi
    .fn()
    .mockResolvedValue({ id: 'scan', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const scan = await globals.window.api.workspaceCleanup.scan()
  expect(scan.candidates.map((c) => c.executionHostId)).toEqual(['runtime:web-env-1', 'ssh:box'])
  expect(scan.candidates[0]?.blockers).toEqual(result.candidates[0]?.blockers)
  expect(scan.errors[0]?.executionHostId).toBe('runtime:web-env-1')
  expect(await globals.window.api.workspaceCleanup.getCachedScan()).toBeNull()
})

it('surfaces an unsupported server response instead of accepting an empty scan', async () => {
  const call = vi
    .fn()
    .mockResolvedValue({
      id: 'scan',
      ok: false,
      error: { code: 'method_not_found', message: 'Update the server' },
      _meta: { runtimeId: 'runtime-1' }
    })
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  await expect(globals.window.api.workspaceCleanup.scan()).rejects.toThrow('Update the server')
})
