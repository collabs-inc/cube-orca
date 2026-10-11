import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCubeServer } from './server.mjs'

const offer = {
  v: 2,
  scope: 'runtime',
  endpoint: 'ws://127.0.0.1:9999',
  deviceToken: 'private-token',
  publicKeyB64: 'host-key'
}
const pairingUrl = 'orca://pair?code=' + Buffer.from(JSON.stringify(offer)).toString('base64url')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orca-gateway-'))
  await mkdir(join(root, 'web/assets'), { recursive: true })
  await writeFile(join(root, 'web/web-index.html'), '<html>Orca web</html>')
  await writeFile(join(root, 'web/assets/app.js'), 'console.log("orca")')
  await writeFile(join(root, 'secret'), 'do not serve')
  await symlink(join(root, 'secret'), join(root, 'web/assets/leak.js'))
  const upstream = createServer((req, res) => res.end('private RPC server'))
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const server = createCubeServer({
    webRoot: join(root, 'web'),
    runtimePort: upstream.address().port,
    pairingUrl
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(async () => {
    server.closeClients()
    server.close()
    upstream.closeAllConnections()
    upstream.close()
    await rm(root, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${server.address().port}`, upstream }
}
function raw(base, headers = {}, path = '/') {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}
test('bootstraps genuine upstream pairing with the public HTTPS endpoint', async (t) => {
  const { base } = await fixture(t)
  const response = await raw(base, {
    Host: 'orca-test.cube.site',
    'X-Forwarded-Proto': 'https',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate'
  })
  assert.equal(response.status, 302)
  const url = new URL(response.headers.location, 'https://orca-test.cube.site')
  const paired = JSON.parse(
    Buffer.from(new URLSearchParams(url.hash.slice(1)).get('pairing'), 'base64url')
  )
  assert.deepEqual(paired, { ...offer, endpoint: 'wss://orca-test.cube.site/cube/runtime' })
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['referrer-policy'], 'no-referrer')
  assert.ok(!response.body.includes('private-token'))
})
test('serves web assets but no source, traversal, symlink targets or daemon HTTP', async (t) => {
  const { base } = await fixture(t)
  assert.match(await (await fetch(base + '/web-index.html')).text(), /Orca web/)
  assert.equal((await fetch(base + '/assets/app.js')).status, 200)
  for (const path of [
    '/assets/leak.js',
    '/cube/runtime',
    '/.git/config',
    '/%2e%2e/secret',
    '/secret',
    '/assets/%2e%2e/%2e%2e/secret'
  ])
    assert.equal((await raw(base, {}, path)).status, 404, path)
})
test('rejects rebinding hosts, foreign origins and cross-site credential fetches', async (t) => {
  const { base } = await fixture(t)
  assert.equal((await raw(base, { Host: 'evil.example' })).status, 403)
  assert.equal((await raw(base, { Origin: 'https://evil.example' })).status, 403)
  assert.equal(
    (await raw(base, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' })).status,
    403
  )
  assert.equal((await fetch(base, { method: 'POST' })).status, 405)
})
test('relays bidirectional WebSocket frames and refuses a foreign browser origin', async (t) => {
  const { WebSocketServer, WebSocket } = await import('ws')
  const { base, upstream } = await fixture(t)
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.cookie, undefined)
    ws.on('message', (data) => ws.send(data))
  })
  t.after(() => wss.close())
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/cube/runtime', {
    origin: base,
    headers: { Cookie: 'cube-auth=private' }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const message = new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())))
  ws.send('real terminal input')
  assert.equal(await message, 'real terminal input')
  ws.close()
  const foreign = new WebSocket(base.replace('http:', 'ws:') + '/cube/runtime', {
    origin: 'https://evil.example'
  })
  foreign.on('error', () => {})
  await new Promise((resolve) =>
    foreign.once('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 403)
      res.resume()
      foreign.terminate()
      resolve()
    })
  )
  foreign.on('error', () => {})
})
