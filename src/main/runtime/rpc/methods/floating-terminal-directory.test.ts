import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('floating terminal directory RPC', () => {
  it('resolves floating terminal directories with the host trust policy', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this dispatcher route only reads these two runtime methods.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getFloatingTerminalCwd: vi.fn().mockResolvedValue('/home/me')
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const params = { path: '~', requireTrusted: true }
    const response = await dispatcher.dispatch(
      makeRequest('files.resolveFloatingTerminalCwd', params)
    )
    expect(response).toMatchObject({ ok: true, result: '/home/me' })
    expect(runtime.getFloatingTerminalCwd).toHaveBeenCalledWith(params)
  })
})
