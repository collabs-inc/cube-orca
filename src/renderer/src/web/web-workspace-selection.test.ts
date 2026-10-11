import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('restores paired workspace selection after an unrelated session patch', async () => {
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const api = globals.window.api
  const selection = {
    activeRepoId: 'repo',
    activeWorktreeId: 'repo::/repo',
    activeWorkspaceKey: 'worktree:repo::/repo' as const,
    activeWorkspaceExecutionHostId: 'runtime:web-env-1' as const
  }
  await api.session.set({ ...getDefaultWorkspaceSession(), ...selection })
  await api.session.patch({ browserUrlHistory: [] })
  expect(await api.session.get()).toMatchObject(selection)
})
