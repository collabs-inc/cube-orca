import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchOrca, readReadiness } from './launch.mjs'
const payload = {
  v: 2,
  scope: 'runtime',
  endpoint: 'ws://127.0.0.1:1234',
  deviceToken: 'secret',
  publicKeyB64: 'key'
}
const ready = {
  type: 'orca_server_ready',
  boundEndpoint: 'ws://127.0.0.1:1234',
  pairing: {
    available: true,
    url: 'orca://pair?code=' + Buffer.from(JSON.stringify(payload)).toString('base64url')
  },
  health: { terminalDaemon: { selfTest: { ok: true } } }
}
test('accepts only a healthy local runtime readiness message', () => {
  assert.equal(readReadiness('ordinary diagnostic'), null)
  assert.equal(readReadiness(JSON.stringify(ready)).port, 1234)
  assert.throws(
    () => readReadiness(JSON.stringify({ ...ready, boundEndpoint: 'ws://evil.example:1234' })),
    /loopback/
  )
  assert.throws(() => readReadiness(JSON.stringify({ ...ready, health: {} })), /terminal/)
  assert.throws(
    () => readReadiness(JSON.stringify({ ...ready, pairing: { available: false } })),
    /pairing/
  )
})
test('serves only after readiness and stops only the owned child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'out/web'), { recursive: true })
  await writeFile(join(root, 'out/web/web-index.html'), '<html>Orca</html>')
  const entry = join(root, 'fake.mjs')
  await writeFile(
    entry,
    `console.log(${JSON.stringify(JSON.stringify(ready))}); setInterval(()=>{},1000);`
  )
  const app = await launchOrca({
    root,
    entry,
    port: 0,
    state: join(root, 'state'),
    timeoutMs: 2000
  })
  t.after(() => app.stop())
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/web-index.html`)).status, 200)
  await app.stop()
  await app.closed
  assert.throws(() => process.kill(app.pid, 0), /ESRCH/)
})
test('failed and silent children never publish a working app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'fake.mjs')
  await writeFile(entry, 'process.exit(7)')
  await assert.rejects(
    launchOrca({ root, entry, port: 0, state: join(root, 'state'), timeoutMs: 1000 }),
    /exited/
  )
  await writeFile(entry, 'setInterval(()=>{},1000)')
  await assert.rejects(
    launchOrca({ root, entry, port: 0, state: join(root, 'state'), timeoutMs: 100 }),
    /ready/
  )
})

test('cancels startup without leaving its child running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'fake.mjs')
  await writeFile(entry, 'setInterval(()=>{},1000)')
  const controller = new AbortController()
  const pending = launchOrca({
    root,
    entry,
    port: 0,
    state: join(root, 'state'),
    signal: controller.signal,
    timeoutMs: 2000
  })
  controller.abort()
  await assert.rejects(pending, /abort/i)
})
