/// <reference types="electron-vite/node" />
import '../../../../types/build-constants.d.ts'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  createSettingsReadRollbackFixture,
  holdRegisteredSettingsWrite,
  pendingClickChoice,
  readRegisteredSettings,
  restoredClickChoice,
  settingsWindowSend
} from '../../../../main/ipc/settings-read-rollback-fixture'
import { createTestStore } from './store-test-helpers'
import { registerSettingsAndSidebarIpcBridge } from '../../hooks/ipc-events/settings-sidebar-ipc-bridge'
import { terminalLinkClickBehaviorFor } from '../../components/terminal-pane/terminal-link-click-behavior'

const rendererHolder = vi.hoisted(() => {
  const holder: { current?: ReturnType<typeof createTestStore> } = {}
  return holder
})
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => renderer().getState(),
    setState: (state: Parameters<ReturnType<typeof createTestStore>['setState']>[0]) =>
      renderer().setState(state)
  }
}))
const unsubs: (() => void)[] = []
afterEach(() => {
  unsubs.splice(0).forEach((unsubscribe) => unsubscribe())
  rendererHolder.current = undefined
  vi.unstubAllGlobals()
})

function renderer() {
  if (!rendererHolder.current) {
    throw new Error('Missing renderer fixture')
  }
  return rendererHolder.current
}

async function hydrateRegisteredSettings() {
  const subscribers = new Set<(updates: Partial<GlobalSettings>) => void>()
  const ui = Object.fromEntries(
    [
      'onOpenSettings',
      'onOpenSkillShare',
      'onOpenSetupGuide',
      'onOpenFeatureTour',
      'onStateChanged',
      'onToggleLeftSidebar',
      'onToggleRightSidebar',
      'onToggleWorktreePalette',
      'onToggleFloatingTerminal'
    ].map((key) => [key, () => () => {}])
  )
  vi.stubGlobal('window', {
    api: {
      ui,
      settings: {
        get: async () => readRegisteredSettings(),
        onChanged: (callback: (updates: Partial<GlobalSettings>) => void) => {
          subscribers.add(callback)
          return () => subscribers.delete(callback)
        }
      },
      runtimeEnvironments: { list: vi.fn().mockResolvedValue([]) }
    }
  })
  rendererHolder.current = createTestStore()
  renderer().setState({ runtimeEnvironmentCatalogHydrated: true })
  settingsWindowSend.mockImplementation((channel, updates) => {
    if (channel === 'settings:changed') {
      subscribers.forEach((callback) => callback(structuredClone(updates)))
    }
  })
  registerSettingsAndSidebarIpcBridge(unsubs)
  await renderer().getState().fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
  await renderer().getState().awaitOwnerWorktreeVisibilityDefaultsHydration()
}

it.each([
  { name: 'click choice', updates: pendingClickChoice },
  { name: 'destructive preference', updates: { alwaysForceDeleteWorktrees: true } }
] as const)('corrects a read-only hydrated $name after failed storage', async ({ updates }) => {
  const fixture = await createSettingsReadRollbackFixture()
  const diskFailure = new Error('Disk full')
  const held = await holdRegisteredSettingsWrite(fixture, updates, diskFailure)
  const pendingIdentity = fixture.store.getSettings()
  await hydrateRegisteredSettings()
  expect(fixture.store.getSettings()).toBe(pendingIdentity)
  expect(renderer().getState().settings).toMatchObject(updates)
  expect(settingsWindowSend).not.toHaveBeenCalled()
  held.release.resolve()
  expect((await held.result).error).toBe(diskFailure)
  await fixture.store.flushPendingOrThrowAsync()
  expect(renderer().getState().settings).toMatchObject(restoredClickChoice)
  expect(terminalLinkClickBehaviorFor(renderer().getState().settings)).toBe('none')
  expect(fixture.store.getSettings()).toMatchObject(restoredClickChoice)
  expect(fixture.readState().settings).toMatchObject(restoredClickChoice)
})

it('retains a successful durable selection after read-only startup hydration', async () => {
  const fixture = await createSettingsReadRollbackFixture()
  const held = await holdRegisteredSettingsWrite(fixture, pendingClickChoice)
  await hydrateRegisteredSettings()
  held.release.resolve()
  expect((await held.result).error).toBeUndefined()
  await fixture.store.flushPendingOrThrowAsync()
  expect(renderer().getState().settings).toMatchObject(pendingClickChoice)
  expect(terminalLinkClickBehaviorFor(renderer().getState().settings)).toBe('actions')
  expect(fixture.readState().settings).toMatchObject(pendingClickChoice)
})
