import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web preload runtime calls', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('refuses stale pairing and runtime expectations before dispatching mutations', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ id: 'write', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    await globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'status.get'
    })
    call.mockClear()
    for (const expected of [
      { expectedEnvironmentPairingRevision: 99 },
      { expectedEnvironmentRuntimeId: 'replaced-runtime' }
    ]) {
      const result = await globals.window.api.runtimeEnvironments.call({
        selector: 'web-server-a',
        method: 'files.writeBase64Chunk',
        params: {},
        ...expected
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    }
    expect(call).not.toHaveBeenCalled()
    await globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'files.writeBase64Chunk',
      params: {},
      expectedEnvironmentPairingRevision: 1,
      expectedEnvironmentRuntimeId: 'runtime-1'
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rechecks runtime identity when a queued mutation reaches dispatch', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const call = vi.fn(async (method: string) => {
      if (method.startsWith('block')) {
        await blocked
      }
      return {
        id: method,
        ok: true,
        result: {},
        _meta: { runtimeId: method.startsWith('block') ? 'runtime-2' : 'runtime-1' }
      }
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { webRuntimeState } = await import('./preload-api/web-runtime-session')
    installWebPreloadApi()
    await globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'status.get'
    })
    call.mockClear()
    const blockers = Array.from({ length: 8 }, (_, i) =>
      globals.window.api.runtime.call({ method: `block.${i}` })
    )
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(8))
    const queued = globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'files.writeBase64Chunk',
      params: {},
      expectedEnvironmentRuntimeId: 'runtime-1'
    })
    if (!webRuntimeState.activeEnvironment) {
      throw new Error('Missing runtime')
    }
    webRuntimeState.activeEnvironment = {
      ...webRuntimeState.activeEnvironment,
      runtimeId: 'runtime-2'
    }
    release()
    await Promise.all(blockers)
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_environment_changed' }
    })
    expect(call.mock.calls.some(([method]) => method === 'files.writeBase64Chunk')).toBe(false)
  })

  it('resolves setup terminal directories on the paired runtime', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'cwd',
      _meta: { runtimeId: 'test-runtime' },
      ok: true,
      result: '/home/cube-user'
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.app.getFloatingTerminalCwd({ path: '~' })).resolves.toBe(
      '/home/cube-user'
    )
    expect(call).toHaveBeenCalledWith(
      'files.resolveFloatingTerminalCwd',
      { path: '~' },
      expect.anything()
    )
    await globals.window.api.app.getFloatingTerminalCwd({
      path: '/untrusted',
      requireTrusted: true
    })
    expect(call).toHaveBeenLastCalledWith(
      'files.resolveFloatingTerminalCwd',
      { path: '/untrusted', requireTrusted: true },
      expect.anything()
    )
    call.mockResolvedValue({
      id: 'cwd',
      _meta: { runtimeId: 'test-runtime' },
      ok: false,
      error: { code: 'offline', message: 'Host disconnected' }
    })
    await expect(globals.window.api.app.getFloatingTerminalCwd()).rejects.toThrow(
      'Host disconnected'
    )
  })

  it('reads resource usage from the paired runtime instead of fabricating zeroes', async () => {
    const snapshot = { totalMemory: 123456, worktrees: [{ id: 'remote-worktree' }] }
    const call = vi.fn().mockResolvedValue({ id: 'memory', _meta: {}, ok: true, result: snapshot })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    await expect(globals.window.api.memory.getSnapshot()).resolves.toEqual({
      ...snapshot,
      runtimeHostId: 'runtime:web-env-1'
    })
    expect(call).toHaveBeenCalledWith('diagnostics.memory', undefined, expect.anything())
    call.mockResolvedValue({
      id: 'memory',
      _meta: {},
      ok: false,
      error: { code: 'offline', message: 'Host disconnected' }
    })
    await expect(globals.window.api.memory.getSnapshot()).rejects.toThrow('Host disconnected')
  })

  it('preserves success and failure envelopes while persisting response runtime metadata', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'runtime.failure') {
            return Promise.resolve({
              id: method,
              ok: false,
              error: { code: 'remote_failure', message: 'Remote failed', data: { retry: false } },
              _meta: { runtimeId: 'runtime-failure' }
            })
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: { value: 42 },
            _meta: { runtimeId: 'runtime-success' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.runtime.call({ method: 'runtime.success' })).resolves.toEqual({
      id: 'runtime.success',
      ok: true,
      result: { value: 42 },
      _meta: { runtimeId: 'runtime-success' }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ runtimeId: 'runtime-success' })

    await expect(globals.window.api.runtime.call({ method: 'runtime.failure' })).resolves.toEqual({
      id: 'runtime.failure',
      ok: false,
      error: { code: 'remote_failure', message: 'Remote failed', data: { retry: false } },
      _meta: { runtimeId: 'runtime-failure' }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ runtimeId: 'runtime-failure' })
  })

  it('unwraps domain failures with their code after persisting failure metadata', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: false,
            error: {
              code: 'repo_unavailable',
              message: 'Repository catalog is unavailable',
              data: { host: 'runtime-a' }
            },
            _meta: { runtimeId: 'runtime-domain-failure' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    let rejection: unknown
    try {
      await globals.window.api.repos.list()
    } catch (error) {
      rejection = error
    }

    expect(rejection).toEqual(
      Object.assign(new Error('Repository catalog is unavailable'), { code: 'repo_unavailable' })
    )
    if (!(rejection instanceof Error)) {
      throw new Error('Expected a domain Error rejection')
    }
    expect('code' in rejection ? rejection.code : undefined).toBe('repo_unavailable')
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ runtimeId: 'runtime-domain-failure' })
  })

  it('surfaces per-environment queue overload without invoking the client', async () => {
    let release!: () => void
    const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      release = () =>
        resolve({
          id: 'runtime.blocked',
          ok: true,
          result: null,
          _meta: { runtimeId: 'runtime-a' }
        })
    })
    const call = vi.fn(() => blocked)
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const accepted = Array.from({ length: 264 }, (_, index) =>
      globals.window.api.runtime.call({ method: `runtime.blocked.${index}` })
    )
    const overloaded = globals.window.api.runtime.call({ method: 'runtime.overloaded' })

    await expect(overloaded).rejects.toMatchObject({
      code: 'runtime_rpc_queue_overloaded',
      scope: 'selector'
    })
    expect(call).toHaveBeenCalledTimes(8)
    release()
    await expect(Promise.all(accepted)).resolves.toHaveLength(264)
  })

  it('does not spend a selected call timeout while queued and forwards it unchanged', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      release = () =>
        resolve({
          id: 'runtime.blocker',
          ok: true,
          result: null,
          _meta: { runtimeId: 'runtime-a' }
        })
    })
    const call = vi.fn((method: string): Promise<RuntimeRpcResponse<unknown>> => {
      if (method.startsWith('runtime.blocker')) {
        return blocked
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: 'done',
        _meta: { runtimeId: 'runtime-a' }
      })
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const blockers = Array.from({ length: 8 }, (_, index) =>
      globals.window.api.runtime.call({ method: `runtime.blocker.${index}` })
    )
    const queued = globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'runtime.queued-timeout',
      timeoutMs: 25
    })
    let settled = false
    void queued.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
    expect(call).toHaveBeenCalledTimes(8)
    release()
    await Promise.all(blockers)
    await expect(queued).resolves.toMatchObject({ ok: true, result: 'done' })
    expect(call).toHaveBeenLastCalledWith('runtime.queued-timeout', undefined, { timeoutMs: 25 })
  })
})
