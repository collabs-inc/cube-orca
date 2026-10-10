import { beforeEach, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../../persistence/loading-store/profile-state-maintenance-fixture'

type SettingsHandler = (
  event?: { sender: { id: number } },
  args?: Partial<GlobalSettings>
) => unknown
const { handleMock, settingsWindowSend, settingsOriginSend } = vi.hoisted(() => ({
  handleMock: vi.fn<(channel: string, handler: SettingsHandler) => void>(),
  settingsWindowSend: vi.fn<(channel: string, updates: Partial<GlobalSettings>) => void>(),
  settingsOriginSend: vi.fn<(channel: string, updates: Partial<GlobalSettings>) => void>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test/user-data' },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { id: 7, send: settingsOriginSend } },
      { isDestroyed: () => false, webContents: { id: 29, send: settingsWindowSend } }
    ]
  },
  ipcMain: { handle: handleMock, on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../ghostty/index', () => ({ previewGhosttyImport: vi.fn() }))
vi.mock('../../warp-themes', () => ({ previewWarpThemeImport: vi.fn() }))
vi.mock('../../network/proxy-settings', () => ({ applyElectronProxySettings: vi.fn() }))
vi.mock('../../browser/browser-session-proxy', () => ({ applyBrowserSessionProxies: vi.fn() }))
vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: () => [] }
}))
vi.mock('../../app-icon', () => ({ applyAppIcon: vi.fn() }))
vi.mock('../../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn()
}))
vi.mock('../../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn()
}))
vi.mock('../../worktree-root-preparation', () => ({ prepareLocalWorktreeRootsForRepos: vi.fn() }))
vi.mock('../../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../../i18n/main-i18n', () => ({ setMainUiLanguage: vi.fn() }))

import { registerSettingsHandlers } from '../settings'
export { settingsWindowSend, settingsOriginSend }
export const restoredClickChoice = {
  terminalLinkClickBehavior: 'none',
  terminalLinkActionPopoverEnabled: false,
  alwaysForceDeleteWorktrees: false
} as const
export const pendingClickChoice = {
  terminalLinkClickBehavior: 'actions',
  terminalLinkActionPopoverEnabled: true,
  alwaysForceDeleteWorktrees: true
} as const

beforeEach(() => {
  handleMock.mockClear()
  settingsWindowSend.mockReset()
  settingsOriginSend.mockReset()
})

function handler(channel: string): SettingsHandler {
  const registered = handleMock.mock.calls.find(([name]) => name === channel)?.[1]
  if (!registered) {
    throw new Error(`Missing handler ${channel}`)
  }
  return registered
}

export function readRegisteredSettings(): unknown {
  return structuredClone(handler('settings:get')())
}

export async function createSettingsReadRollbackFixture() {
  const fixture = await createWorkerMaintenanceFixture()
  fixture.store.updateSettings({ ...restoredClickChoice, activeRuntimeEnvironmentId: null })
  await fixture.store.flushPendingOrThrowAsync()
  registerSettingsHandlers(fixture.store)
  return fixture
}

export async function holdRegisteredSettingsWrite(
  fixture: Awaited<ReturnType<typeof createSettingsReadRollbackFixture>>,
  updates: Partial<GlobalSettings>,
  diskFailure?: Error
) {
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  const write = fixture.authority.writeSerializedDomains.bind(fixture.authority)
  vi.spyOn(fixture.authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
    started.resolve()
    await release.promise
    if (diskFailure) {
      throw diskFailure
    }
    await write(domains)
  })
  const pending = handler('settings:set')({ sender: { id: 7 } }, updates)
  const result = Promise.resolve(pending).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )
  await started.promise
  return { release, result }
}
