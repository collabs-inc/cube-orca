import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchElectronServe } from './electron-runtime.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = process.env.ORCA_USER_DATA
if (!state) throw Error('Missing Orca state directory')
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => controller.abort())
try {
  const app = await launchElectronServe({ root, state, signal: controller.signal })
  process.exitCode = await app.closed
} catch (error) {
  if (!controller.signal.aborted) throw error
}
