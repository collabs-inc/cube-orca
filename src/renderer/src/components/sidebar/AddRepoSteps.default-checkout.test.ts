import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  storeState: {
    repos: [] as Repo[],
    projects: [],
    projectHostSetups: [],
    clearOrcaHookTrustForRepo: vi.fn(),
    openModal: vi.fn(),
    cancelNestedRepoScan: vi.fn(),
    sshStateByEnvironment: new Map()
  },
  listServerTargets: vi.fn(),
  addServerRepo: vi.fn(),
  connectServerTarget: vi.fn(),
  addRemote: vi.fn(),
  listTargets: vi.fn(),
  getState: vi.fn(),
  onStateChanged: vi.fn(() => vi.fn()),
  fetchWorktrees: vi.fn(),
  onGitRepoReady: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useMemo: <T>(factory: () => T) => factory(),
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => ({ current: value }),
    useState: <T>(initial: T | (() => T)) => {
      const index = mocks.stateIndex++
      const value =
        index in mocks.stateValues
          ? mocks.stateValues[index]
          : typeof initial === 'function'
            ? (initial as () => T)()
            : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value as T, setter]
    }
  }
})

vi.mock('@/hooks/useMountedRef', () => ({
  useMountedRef: () => ({ current: true })
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
    {
      getState: () => mocks.storeState,
      setState: (next: Partial<typeof mocks.storeState>) => {
        Object.assign(mocks.storeState, next)
      }
    }
  )
  return { useAppStore }
})

vi.mock('@/runtime/runtime-ssh-target-management', () => ({
  listRuntimeEditableSshTargets: mocks.listServerTargets,
  addRuntimeSshRepo: mocks.addServerRepo
}))

vi.mock('@/runtime/runtime-environment-ssh-state', () => ({
  connectRuntimeEnvironmentSshTarget: mocks.connectServerTarget
}))

vi.mock('../../../../shared/nested-repo-telemetry', () => ({
  createNestedRepoTelemetryAttemptId: () => 'attempt-1'
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-remote',
    path: '/srv/repo',
    displayName: 'remote-repo',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('useRemoteRepo default-checkout handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = [[], 'ssh-1', '/srv/repo', null, false, null]
    mocks.storeState.repos = []
    mocks.storeState.projects = []
    mocks.storeState.projectHostSetups = []
    mocks.listTargets.mockResolvedValue([
      { id: 'ssh-1', label: 'Builder 1' },
      { id: 'ssh-2', label: 'Builder 2' }
    ])
    mocks.getState.mockResolvedValue({ status: 'connected' })
    vi.stubGlobal('window', {
      api: {
        ssh: {
          listTargets: mocks.listTargets,
          getState: mocks.getState,
          onStateChanged: mocks.onStateChanged
        },
        repos: {
          addRemote: mocks.addRemote
        }
      }
    })
  })

  it('requests an authoritative worktree refresh before handoff', async () => {
    const repo = makeRepo()
    mocks.addRemote.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null)
    )
    await result.handleAddRemoteRepo()

    expect(mocks.addRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      remotePath: '/srv/repo'
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true,
      executionHostId: 'ssh:ssh-1'
    })
    expect(mocks.storeState.repos).toContainEqual({
      ...repo,
      executionHostId: 'ssh:ssh-1'
    })
    expect(mocks.storeState.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceRepoIds: [repo.id] })])
    )
    expect(mocks.storeState.projectHostSetups).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoId: repo.id, path: repo.path })])
    )
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'ssh:ssh-1')
  })

  it('continues to completion when refresh is not authoritative after remote add', async () => {
    const repo = makeRepo()
    mocks.addRemote.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(false)
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null)
    )
    await result.handleAddRemoteRepo()

    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true,
      executionHostId: 'ssh:ssh-1'
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'ssh:ssh-1')
    expect(mocks.stateSetters[3]).not.toHaveBeenCalledWith(
      'Could not refresh project worktrees. Try again.'
    )
  })

  it('preselects the preferred SSH target when opening Browse for a selected host', async () => {
    mocks.stateValues = [[], null, '~/', null, false, null]
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null)
    )
    await result.handleOpenRemoteStep('ssh-2')

    expect(mocks.listTargets).toHaveBeenCalled()
    expect(mocks.getState).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(mocks.getState).toHaveBeenCalledWith({ targetId: 'ssh-2' })
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('ssh-2')
  })

  it('pins SSH nested scans and cancellation to the local provider', async () => {
    const scanNestedRepos = vi.fn().mockResolvedValue(null)
    mocks.addRemote.mockResolvedValue({ repo: makeRepo() })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      scanNestedRepos
    )
    await result.handleAddRemoteRepo()

    expect(scanNestedRepos).toHaveBeenCalledWith(
      '/srv/repo',
      'ssh-1',
      expect.objectContaining({ runtimeEnvironmentId: null })
    )

    mocks.stateIndex = 0
    mocks.stateValues = [[], 'ssh-1', '/srv/repo', null, false, 'scan-ssh']
    const active = useRemoteRepo(mocks.fetchWorktrees, vi.fn(), vi.fn())
    active.stopRemoteNestedScan()
    active.resetRemoteState()

    expect(mocks.storeState.cancelNestedRepoScan).toHaveBeenCalledWith('scan-ssh', {
      runtimeEnvironmentId: null
    })
  })

  // Adapted from the community PR #8492 by @jae-heo.
  describe("a paired server's own SSH hosts (#8489)", () => {
    function serverRemoteRepo(scanNestedRepos = vi.fn().mockResolvedValue(null)) {
      return import('./AddRepoSteps').then(({ useRemoteRepo }) =>
        useRemoteRepo(
          mocks.fetchWorktrees,
          vi.fn(),
          vi.fn(),
          mocks.onGitRepoReady,
          scanNestedRepos,
          undefined,
          undefined,
          'env-linux'
        )
      )
    }

    it("lists the server's hosts, never this client's", async () => {
      mocks.stateValues = [[], null, '~/', null, false, null]
      mocks.listServerTargets.mockResolvedValue([
        {
          id: 'ssh-p8',
          label: 'p8',
          host: 'p8',
          port: 22,
          username: 'me',
          connectionStatus: 'connected'
        }
      ])

      const result = await serverRemoteRepo()
      await result.handleOpenRemoteStep('ssh-p8')

      expect(mocks.listServerTargets).toHaveBeenCalledWith('env-linux')
      expect(mocks.listTargets).not.toHaveBeenCalled()
      expect(mocks.getState).not.toHaveBeenCalled()
      expect(mocks.stateSetters[0]).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'ssh-p8',
          state: expect.objectContaining({ status: 'connected' })
        })
      ])
      expect(mocks.stateSetters[1]).toHaveBeenCalledWith('ssh-p8')
    })

    it('shows why when the server cannot list them, with no local fallback', async () => {
      mocks.stateValues = [[], null, '~/', null, false, null]
      mocks.listServerTargets.mockRejectedValue(
        new Error('Update this Orca server to manage its SSH hosts from here.')
      )

      const result = await serverRemoteRepo()
      await result.handleOpenRemoteStep()

      expect(mocks.listTargets).not.toHaveBeenCalled()
      expect(mocks.stateSetters[3]).toHaveBeenCalledWith(
        'Update this Orca server to manage its SSH hosts from here.'
      )
    })

    it('adds the project through the server and refreshes it as server-owned', async () => {
      const repo = makeRepo({ connectionId: 'ssh-p8', executionHostId: 'ssh:ssh-p8' })
      mocks.stateValues = [[], 'ssh-p8', '/srv/repo', null, false, null]
      mocks.addServerRepo.mockResolvedValue(repo)
      mocks.fetchWorktrees.mockResolvedValue(true)
      const scanNestedRepos = vi.fn()

      const result = await serverRemoteRepo(scanNestedRepos)
      await result.handleAddRemoteRepo()

      expect(mocks.addServerRepo).toHaveBeenCalledWith('env-linux', {
        connectionId: 'ssh-p8',
        remotePath: '/srv/repo'
      })
      expect(mocks.addRemote).not.toHaveBeenCalled()
      expect(scanNestedRepos).not.toHaveBeenCalled()
      expect(mocks.storeState.repos).toContainEqual({
        ...repo,
        executionHostId: 'runtime:env-linux'
      })
      expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
        requireAuthoritative: true,
        executionHostId: 'runtime:env-linux'
      })
      expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'runtime:env-linux')
    })

    it('hands a non-git folder to the confirm dialog bound to the server', async () => {
      mocks.stateValues = [[], 'ssh-p8', '/srv/notes', null, false, null]
      mocks.addServerRepo.mockRejectedValue(new Error('Not a valid git repository: /srv/notes'))

      const result = await serverRemoteRepo()
      await result.handleAddRemoteRepo()

      expect(mocks.storeState.openModal).toHaveBeenCalledWith('confirm-non-git-folder', {
        folderPath: '/srv/notes',
        connectionId: 'ssh-p8',
        runtimeEnvironmentId: 'env-linux'
      })
    })

    it('connects the host through the server', async () => {
      mocks.stateValues = [[], null, '~/', null, false, null]
      mocks.connectServerTarget.mockResolvedValue({
        targetId: 'ssh-p8',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      const sshConnect = vi.fn()
      Object.assign(window.api.ssh, { connect: sshConnect })

      const result = await serverRemoteRepo()
      await result.handleConnectTarget('ssh-p8')

      expect(mocks.connectServerTarget).toHaveBeenCalledWith('env-linux', 'ssh-p8')
      expect(sshConnect).not.toHaveBeenCalled()
    })
  })
})
