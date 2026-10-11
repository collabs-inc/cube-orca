// Cube integration. State lives outside the replaceable app checkout.
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { launchOrca } from './launch.mjs'
const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error('PORT must be a valid TCP port')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
process.once('SIGHUP', () => controller.abort())
try {
  const app = await launchOrca({
    root,
    entry: join(root, 'cube/electron.mjs'),
    port,
    state: process.env.ORCA_CUBE_STATE_DIR || join(homedir(), '.orca', 'cube'),
    signal: controller.signal
  })
  console.log(`Orca for Cube listening on 127.0.0.1:${app.port}`)
  process.exitCode = await app.closed
} catch (error) {
  if (!controller.signal.aborted) throw error
}
