// Cube integration: supervise only the runtime started by this launcher.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createCubeServer } from './server.mjs'

export function readReadiness(line) {
  let data
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (data.type !== 'orca_server_ready') return null
  const endpoint = new URL(data.boundEndpoint)
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !Number(endpoint.port))
    throw Error('Runtime must bind a private loopback port')
  if (!data.pairing?.available || typeof data.pairing.url !== 'string')
    throw Error('Runtime pairing is unavailable')
  if (data.health?.terminalDaemon?.selfTest?.ok !== true)
    throw Error('Runtime terminal self-test failed')
  return { port: Number(endpoint.port), pairingUrl: data.pairing.url }
}

export async function launchOrca({
  root,
  port,
  state,
  entry = join(root, 'out/orcad/orcad.js'),
  timeoutMs = 90000,
  env = process.env,
  signal
}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid Cube port')
  await mkdir(state, { recursive: true, mode: 0o700 })
  signal?.throwIfAborted()
  const child = spawn(process.execPath, [entry, '--port', '0', '--bind', '127.0.0.1', '--json'], {
    cwd: root,
    env: { ...env, ORCA_USER_DATA: state, ORCA_BACKGROUND_LAUNCH: '1' },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  let server
  let stopping = false
  let exitCode = 0
  const closed = new Promise((resolve) => {
    const exited = (code) => {
      // Persistent terminal descendants may retain stdout after this child exits.
      child.stdout.destroy()
      exitCode = stopping ? 0 : code || 1
      resolve(exitCode)
    }
    child.once('exit', exited)
    // Spawn errors emit close without exit.
    child.once('close', exited)
  })
  const stop = async () => {
    if (!stopping) {
      stopping = true
      server?.closeClients()
      server?.close()
      child.kill('SIGTERM')
    }
    const force = setTimeout(() => child.kill('SIGKILL'), 10000)
    force.unref()
    await closed
    clearTimeout(force)
  }
  const abort = () => void stop()
  signal?.addEventListener('abort', abort, { once: true })
  child.once('exit', () => {
    signal?.removeEventListener('abort', abort)
    server?.closeClients()
    server?.close()
  })
  try {
    const readiness = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      const timer = setTimeout(() => {
        cleanup()
        reject(Error('Orca did not become ready in time'))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        lines.close()
        child.off('error', onError)
        child.off('exit', onExit)
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const onExit = (code) => {
        cleanup()
        reject(Error(`Orca exited before readiness (${code})`))
      }
      child.once('error', onError)
      child.once('exit', onExit)
      lines.on('line', (line) => {
        try {
          const result = readReadiness(line)
          if (result) {
            cleanup()
            resolve(result)
          }
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    })
    signal?.throwIfAborted()
    if (child.exitCode !== null) throw Error('Orca exited during startup')
    // The readiness line contains credentials. Do not forward stdout to Cube logs.
    child.stdout.resume()
    server = createCubeServer({
      webRoot: join(root, 'out/web'),
      runtimePort: readiness.port,
      pairingUrl: readiness.pairingUrl
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    return { port: server.address().port, pid: child.pid, stop, closed }
  } catch (error) {
    await stop()
    if (signal?.aborted) throw Error('Orca startup aborted')
    throw error
  }
}
