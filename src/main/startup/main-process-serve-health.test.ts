import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  collect: vi.fn().mockResolvedValue({ state: 'degraded', selfTest: { ok: false } })
}))
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }))
vi.mock('../serve-update-handoff', () => ({ notifyServeSupervisorReady: vi.fn() }))
vi.mock('../orcad/orcad-health', () => ({
  computeOrcadBuildHash: () => 'fixture-build',
  collectTerminalDaemonHealth: mocks.collect
}))
vi.mock('../server/serve-pairing-readiness', () => ({
  servePublishMode: () => ({ mode: 'json' }),
  buildServePairingReadiness: async () => ({ boundEndpoint: 'ws://127.0.0.1:1234' })
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    runtime: { getRuntimeId: () => 'runtime' },
    runtimeRpc: {},
    managedWslCliReconciliationStatus: 'settled',
    serveReadinessPublisher: { publish: mocks.publish }
  }
}))
import { printServeReady, getServeOptions } from './main-process-serve'
it('reports the real daemon health without advertising orcad-only stop support', async () => {
  await printServeReady(getServeOptions(['orca', '--serve', '--serve-json']))
  expect(mocks.collect).toHaveBeenCalledOnce()
  expect(mocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      health: expect.objectContaining({
        buildHash: 'fixture-build',
        buildVersion: '1.0.0',
        terminalDaemon: { state: 'degraded', selfTest: { ok: false } }
      })
    }),
    { mode: 'json' }
  )
  expect(mocks.publish.mock.calls[0][0].health).not.toHaveProperty('stopRequests')
})
