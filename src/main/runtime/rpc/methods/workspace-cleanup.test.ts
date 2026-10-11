import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKSPACE_CLEANUP_METHODS } from './workspace-cleanup'
import type { WorkspaceCleanupScanArgs } from '../../../../shared/workspace-cleanup'

it('scans with the existing runtime scanner and isolates cancellation by connection', async () => {
  let signal: AbortSignal | undefined
  let finish!: () => void
  const scan = vi.fn((_args: WorkspaceCleanupScanArgs, nextSignal: AbortSignal) => {
    signal = nextSignal
    return new Promise((resolve) => {
      finish = () => resolve({ scannedAt: 1, candidates: [], errors: [] })
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only runtime identity and the scan method are reached by these two RPC methods.
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    scanWorkspaceCleanup: scan
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_CLEANUP_METHODS })
  const request = (method: string) => ({
    id: method,
    authToken: 'test',
    method,
    params: { scanId: 'scan-1' }
  })
  const pending = dispatcher.dispatch(request('workspaceCleanup.scan'), {
    connectionId: 'client-a'
  })
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
  expect(
    await dispatcher.dispatch(request('workspaceCleanup.cancelScan'), { connectionId: 'client-b' })
  ).toMatchObject({ ok: true, result: false })
  expect(signal?.aborted).toBe(false)
  expect(
    await dispatcher.dispatch(request('workspaceCleanup.cancelScan'), { connectionId: 'client-a' })
  ).toMatchObject({ ok: true, result: true })
  expect(signal?.aborted).toBe(true)
  finish()
  expect(await pending).toMatchObject({ ok: true, result: { candidates: [] } })
  expect(
    await dispatcher.dispatch(request('workspaceCleanup.cancelScan'), { connectionId: 'client-a' })
  ).toMatchObject({ ok: true, result: false })
})
