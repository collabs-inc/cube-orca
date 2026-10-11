// Cube integration. Upstream Orca is MIT licensed.
import { createServer, request } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf'
}
const publicPath = /^\/(web-index\.html|(?:assets|cmaps|standard_fonts|wasm)\/[^\0]+)$/

function browserOrigin(req) {
  const host = req.headers.host
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.cube\.site)(?::\d+)?$/i.test(host))
    return null
  const origin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${host}`
  if (req.headers.origin && req.headers.origin !== origin) return null
  if (
    req.headers['sec-fetch-site'] === 'cross-site' &&
    req.headers['sec-fetch-mode'] !== 'navigate'
  )
    return null
  return origin
}

export function createCubeServer({ webRoot, runtimePort, pairingUrl }) {
  const pair = new URL(pairingUrl)
  if (pair.protocol !== 'orca:' || pair.hostname !== 'pair')
    throw Error('Invalid runtime pairing URL')
  const offer = JSON.parse(
    Buffer.from(pair.searchParams.get('code') || pair.hash.slice(1), 'base64url')
  )
  if (offer.v !== 2 || offer.scope !== 'runtime' || !offer.deviceToken || !offer.publicKeyB64)
    throw Error('Runtime did not provide a compatible pairing offer')
  const root = resolve(webRoot)
  const sockets = new Set()
  const reply = (res, code, body) => {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(body)
  }
  const server = createServer(async (req, res) => {
    const origin = browserOrigin(req)
    if (!origin) return reply(res, 403, 'Origin or host is not allowed')
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed')
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (path === '/') {
        const payload = Buffer.from(
          JSON.stringify({ ...offer, endpoint: origin.replace(/^http/, 'ws') + '/cube/runtime' })
        ).toString('base64url')
        res.writeHead(302, {
          Location: '/web-index.html#pairing=' + payload,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer'
        })
        return res.end()
      }
      if (
        !publicPath.test(path) ||
        path.includes('\\') ||
        path.split('/').some((p) => p.startsWith('.'))
      )
        return reply(res, 404, 'Not found')
      const file = await realpath(resolve(root, '.' + path))
      if (!file.startsWith(root + sep)) return reply(res, 404, 'Not found')
      const data = await readFile(file)
      res.writeHead(200, {
        'Content-Type': types[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      })
      res.end(req.method === 'HEAD' ? undefined : data)
    } catch {
      reply(res, 404, 'Not found')
    }
  })
  server.on('upgrade', (req, socket, head) => {
    if (!browserOrigin(req) || req.url !== '/cube/runtime') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = request({
      host: '127.0.0.1',
      port: runtimePort,
      path: '/',
      headers: {
        host: `127.0.0.1:${runtimePort}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': req.headers['sec-websocket-key'],
        'sec-websocket-version': req.headers['sec-websocket-version'],
        ...(req.headers['sec-websocket-protocol']
          ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] }
          : {})
      }
    })
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote)
      remote.once('close', () => sockets.delete(remote))
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')}\r\n\r\n`
      )
      if (remoteHead.length) socket.write(remoteHead)
      if (head.length) remote.write(head)
      socket.pipe(remote)
      remote.pipe(socket)
      remote.on('error', () => socket.destroy())
      socket.on('error', () => remote.destroy())
      remote.on('close', () => socket.destroy())
      socket.on('close', () => remote.destroy())
    })
    upstream.on('response', (res) => {
      res.resume()
      socket.destroy()
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.end()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.closeClients = () => {
    for (const socket of sockets) socket.destroy()
  }
  return server
}
