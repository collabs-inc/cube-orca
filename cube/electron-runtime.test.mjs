import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchElectronServe, electronServeEnvironment } from './electron-runtime.mjs'

test('pins the profile and removes inherited Electron development overrides', () => {
  const env = electronServeEnvironment('/app', '/state', ':44', {
    PATH: '/bin',
    HOME: '/home/test',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_RENDERER_URL: 'http://wrong',
    ORCA_E2E_USER_DATA_DIR: '/other'
  })
  assert.equal(env.ORCA_DEV_USER_DATA_PATH, '/state')
  assert.equal(env.ORCA_SERVE_USER_DATA_PATH, '/state')
  assert.equal(env.HOME, '/home/test')
  assert.equal(env.DISPLAY, ':44')
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.ELECTRON_RENDERER_URL, undefined)
  assert.equal(env.ORCA_E2E_USER_DATA_DIR, undefined)
})

test('stops only its Electron process and display when cancelled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-electron-supervisor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const display = join(root, 'display'),
    electron = join(root, 'electron')
  await writeFile(
    display,
    `#!${process.execPath}\nrequire('fs').writeSync(3,'44\\n');setInterval(()=>{},1000)`,
    { mode: 0o755 }
  )
  await writeFile(electron, `#!${process.execPath}\nsetInterval(()=>{},1000)`, { mode: 0o755 })
  const controller = new AbortController()
  const app = await launchElectronServe({
    root,
    state: join(root, 'state'),
    signal: controller.signal,
    displayExecutable: display,
    electronExecutable: electron
  })
  t.after(() => app.stop())
  assert.ok(app.pid > 0)
  controller.abort()
  assert.equal(await app.closed, 0)
  assert.throws(() => process.kill(app.pid, 0), /ESRCH/)
  assert.throws(() => process.kill(app.displayPid, 0), /ESRCH/)
})

test('a failed Electron launch cleans up its display', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-electron-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const display = join(root, 'display')
  await writeFile(
    display,
    `#!${process.execPath}\nrequire('fs').writeSync(3,'44\\n');setInterval(()=>{},1000)`,
    { mode: 0o755 }
  )
  await assert.rejects(
    launchElectronServe({
      root,
      state: join(root, 'state'),
      displayExecutable: display,
      electronExecutable: join(root, 'missing')
    }),
    /ENOENT/
  )
})

test(
  'display failure force-stops an unresponsive Electron process',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-display-failure-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const display = join(root, 'display'),
      electron = join(root, 'electron')
    await writeFile(
      display,
      `#!${process.execPath}\nrequire('fs').writeSync(3,'44\\n');setInterval(()=>{},1000)`,
      { mode: 0o755 }
    )
    await writeFile(
      electron,
      `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(join(root, 'ready'))},'ready');setInterval(()=>{},1000)`,
      { mode: 0o755 }
    )
    const app = await launchElectronServe({
      root,
      state: join(root, 'state'),
      displayExecutable: display,
      electronExecutable: electron
    })
    t.after(() => app.stop())
    const { access } = await import('node:fs/promises')
    for (let n = 0; ; n++) {
      try {
        await access(join(root, 'ready'))
        break
      } catch (error) {
        if (n > 100) throw error
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    process.kill(app.displayPid, 'SIGKILL')
    const result = await Promise.race([
      app.closed,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 6500))
    ])
    assert.equal(result, 1)
    assert.throws(() => process.kill(app.pid, 0), /ESRCH/)
  }
)

test('prefers real agents while retaining Cube URL opener commands on PATH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cube-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const wrapper = join(root, 'cube-bin'),
    binaries = join(root, 'real-bin'),
    state = join(root, 'state')
  const { mkdir, readlink } = await import('node:fs/promises')
  await mkdir(wrapper)
  await mkdir(binaries)
  await writeFile(
    join(wrapper, 'codex'),
    '#!/bin/sh\n# Written by cubed (shell-wrappers.ts): generated\n',
    { mode: 0o755 }
  )
  await writeFile(join(binaries, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const original = `${wrapper}:${binaries}:/usr/bin`
  const env = electronServeEnvironment(root, state, ':44', { PATH: original })
  assert.equal(env.PATH, `${state}/cli/bin:${original}`)
  assert.equal(await readlink(join(state, 'cli/bin/codex')), join(binaries, 'codex'))
  assert.equal(electronServeEnvironment(root, state, ':44', { PATH: original }).PATH, env.PATH)
  assert.equal(
    electronServeEnvironment(root, state, ':44', { PATH: '/custom:/usr/bin' }).PATH,
    '/custom:/usr/bin'
  )
})

test('removes obsolete owned agent links without overwriting user commands', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cube-path-change-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { mkdir, lstat, readFile } = await import('node:fs/promises')
  const wrapper = join(root, 'cube'),
    real = join(root, 'real'),
    custom = join(root, 'custom'),
    state = join(root, 'state')
  for (const dir of [wrapper, real, custom]) await mkdir(dir)
  await writeFile(
    join(wrapper, 'codex'),
    '#!/bin/sh\n# Written by cubed (shell-wrappers.ts): generated\n',
    { mode: 0o755 }
  )
  for (const dir of [real, custom])
    await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  electronServeEnvironment(root, state, ':44', { PATH: `${wrapper}:${real}` })
  electronServeEnvironment(root, state, ':44', {
    PATH: `${state}/cli/bin:${custom}:${wrapper}:${real}`
  })
  await assert.rejects(lstat(join(state, 'cli/bin/codex')), { code: 'ENOENT' })
  await writeFile(join(state, 'cli/bin/codex'), 'user command', { mode: 0o755 })
  electronServeEnvironment(root, state, ':44', { PATH: `${wrapper}:${real}` })
  assert.equal(await readFile(join(state, 'cli/bin/codex'), 'utf8'), 'user command')
})
