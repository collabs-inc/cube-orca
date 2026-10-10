import { expect, it, vi } from 'vitest'
import {
  createSettingsReadRollbackFixture,
  holdRegisteredSettingsWrite,
  pendingClickChoice,
  readRegisteredSettings,
  restoredClickChoice,
  settingsOriginSend,
  settingsWindowSend
} from './__mocks__/settings-read-rollback-fixture'

it.each([
  { name: 'click choice', updates: pendingClickChoice, restored: restoredClickChoice },
  {
    name: 'destructive preference',
    updates: { alwaysForceDeleteWorktrees: true },
    restored: { alwaysForceDeleteWorktrees: false }
  }
] as const)(
  'reconciles a read-only settings:get after a failed $name save',
  async ({ updates, restored }) => {
    const fixture = await createSettingsReadRollbackFixture()
    const diskFailure = new Error('Disk full')
    const held = await holdRegisteredSettingsWrite(fixture, updates, diskFailure)
    const pendingIdentity = fixture.store.getSettings()
    expect(readRegisteredSettings()).toMatchObject(updates)
    expect(fixture.store.getSettings()).toBe(pendingIdentity)
    expect(settingsWindowSend).not.toHaveBeenCalled()
    held.release.resolve()
    expect((await held.result).error).toBe(diskFailure)
    await fixture.store.flushPendingOrThrowAsync()
    expect(readRegisteredSettings()).toMatchObject(restoredClickChoice)
    expect(fixture.readState().settings).toMatchObject(restoredClickChoice)
    expect(settingsWindowSend).toHaveBeenCalledExactlyOnceWith('settings:changed', restored)
    expect(settingsOriginSend).toHaveBeenCalledExactlyOnceWith('settings:changed', restored)
  }
)

it('publishes a successful durable selection after a read-only settings:get', async () => {
  const fixture = await createSettingsReadRollbackFixture()
  const held = await holdRegisteredSettingsWrite(fixture, pendingClickChoice)
  expect(readRegisteredSettings()).toMatchObject(pendingClickChoice)
  held.release.resolve()
  expect((await held.result).error).toBeUndefined()
  await fixture.store.flushPendingOrThrowAsync()
  expect(readRegisteredSettings()).toMatchObject(pendingClickChoice)
  expect(fixture.readState().settings).toMatchObject(pendingClickChoice)
  expect(settingsWindowSend).toHaveBeenCalledExactlyOnceWith('settings:changed', pendingClickChoice)
  expect(settingsOriginSend).not.toHaveBeenCalled()
})

it('publishes only restored fields after failure without an intervening read or write', async () => {
  const fixture = await createSettingsReadRollbackFixture()
  const diskFailure = new Error('Disk full')
  const held = await holdRegisteredSettingsWrite(fixture, pendingClickChoice, diskFailure)
  held.release.resolve()
  expect((await held.result).error).toBe(diskFailure)
  await fixture.store.flushPendingOrThrowAsync()
  expect(fixture.store.getSettings()).toMatchObject(restoredClickChoice)
  expect(fixture.readState().settings).toMatchObject(restoredClickChoice)
  expect(settingsWindowSend).toHaveBeenCalledExactlyOnceWith(
    'settings:changed',
    restoredClickChoice
  )
})

it.each([
  { name: 'empty affected keys', updates: {}, notifyListeners: true },
  {
    name: 'notifications disabled',
    updates: { terminalLinkClickBehavior: 'actions' },
    notifyListeners: false
  }
] as const)('keeps $name silent after failed storage', async ({ updates, notifyListeners }) => {
  const fixture = await createSettingsReadRollbackFixture()
  const diskFailure = new Error('Disk full')
  vi.spyOn(fixture.authority, 'writeSerializedDomains').mockRejectedValueOnce(diskFailure)
  await expect(fixture.store.updateSettingsAndFlush(updates, { notifyListeners })).rejects.toBe(
    diskFailure
  )
  await fixture.store.flushPendingOrThrowAsync()
  expect(fixture.store.getSettings()).toMatchObject(restoredClickChoice)
  expect(fixture.readState().settings).toMatchObject(restoredClickChoice)
  expect(settingsWindowSend).not.toHaveBeenCalled()
  expect(settingsOriginSend).not.toHaveBeenCalled()
})
