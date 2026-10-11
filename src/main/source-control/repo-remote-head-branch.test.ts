import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, getSshGitProviderMock, getSshGitProviderGenerationMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    getSshGitProviderMock: vi.fn(),
    getSshGitProviderGenerationMock: vi.fn(() => 0)
  })
)

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock
}))

import { bumpScopeGeneration, hostedReviewRepoScope } from './hosted-review-scope-generations'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

import {
  getRemoteHeadBranchName,
  getRepoDefaultBranchName,
  __resetRepoDefaultBranchCacheForTests
} from './repo-default-branch'

function remoteHead(remote: string, branch: string): { stdout: string; stderr: string } {
  return { stdout: `refs/remotes/${remote}/HEAD\0refs/remotes/${remote}/${branch}\n`, stderr: '' }
}

describe('getRemoteHeadBranchName', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    getSshGitProviderGenerationMock.mockReset().mockReturnValue(0)
    __resetRepoDefaultBranchCacheForTests()
  })

  it('keeps remote HEAD caches separate from each other and the repository default', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) =>
      args.includes('refs/remotes/upstream/HEA[D]')
        ? remoteHead('upstream', 'develop')
        : remoteHead('origin', 'main')
    )
    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('main')
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBe('develop')
    await expect(getRemoteHeadBranchName('/repo', 'origin')).resolves.toBe('main')
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBe('develop')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes/upstream/HEA[D]'],
      { cwd: '/repo', timeout: expect.any(Number) }
    )
  })

  it('returns null for a missing remote HEAD without resolving origin', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBeNull()
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a symbolic HEAD pointing into another remote', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'refs/remotes/upstream/HEAD\0refs/remotes/origin/main\n',
      stderr: ''
    })
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBeNull()
  })

  it('shares concurrent probes only for the same remote', async () => {
    let releaseProbe: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      await gate
      return args.includes('refs/remotes/upstream/HEA[D]')
        ? remoteHead('upstream', 'develop')
        : remoteHead('origin', 'main')
    })
    const first = getRemoteHeadBranchName('/repo', 'upstream')
    const second = getRemoteHeadBranchName('/repo', 'upstream')
    const origin = getRemoteHeadBranchName('/repo', 'origin')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2))
    releaseProbe?.()
    await expect(Promise.all([first, second, origin])).resolves.toEqual([
      'develop',
      'develop',
      'main'
    ])
  })

  it('isolates native, WSL and SSH results for the same path and remote', async () => {
    gitExecFileAsyncMock.mockImplementation(async (_args, options: { wslDistro?: string }) =>
      remoteHead('upstream', options.wslDistro ? 'wsl-default' : 'native-default')
    )
    const exec = vi.fn().mockResolvedValue(remoteHead('upstream', 'ssh-default'))
    getSshGitProviderMock.mockReturnValue({ exec })
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBe('native-default')
    await expect(
      getRemoteHeadBranchName('/repo', 'upstream', null, { wslDistro: 'Ubuntu' })
    ).resolves.toBe('wsl-default')
    await expect(getRemoteHeadBranchName('/repo', 'upstream', 'ssh-1')).resolves.toBe('ssh-default')
    expect(exec).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes/upstream/HEA[D]'],
      '/repo',
      { timeoutMs: expect.any(Number) }
    )
  })

  it('does not run local Git for a disconnected SSH host', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    await expect(getRemoteHeadBranchName('/repo', 'upstream', 'ssh-gone')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('caches failed probes briefly, then retries', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(remoteHead('upstream', 'develop'))
    try {
      await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBeNull()
      await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBeNull()
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
      now.mockReturnValue(32_000)
      await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBe('develop')
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('does not reuse defaults from a replaced SSH provider', async () => {
    getSshGitProviderGenerationMock.mockReturnValue(1)
    const exec = vi.fn().mockResolvedValue(remoteHead('upstream', 'old-default'))
    getSshGitProviderMock.mockReturnValue({ exec })
    await expect(getRemoteHeadBranchName('/repo', 'upstream', 'ssh-1')).resolves.toBe('old-default')
    getSshGitProviderGenerationMock.mockReturnValue(2)
    exec.mockResolvedValue(remoteHead('upstream', 'new-default'))
    await expect(getRemoteHeadBranchName('/repo', 'upstream', 'ssh-1')).resolves.toBe('new-default')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('refreshes defaults after the repository review scope is invalidated', async () => {
    gitExecFileAsyncMock.mockResolvedValue(remoteHead('upstream', 'old-default'))
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBe('old-default')
    bumpScopeGeneration(hostedReviewRepoScope('/repo', LOCAL_EXECUTION_HOST_ID))
    gitExecFileAsyncMock.mockResolvedValue(remoteHead('upstream', 'new-default'))
    await expect(getRemoteHeadBranchName('/repo', 'upstream')).resolves.toBe('new-default')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
