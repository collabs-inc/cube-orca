// Cube integration: build upstream Orca without installing or launching Electron.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw Error('This Cube package requires Linux x86_64')
const tools = join(root, 'cube/tools')
await mkdir(tools, { recursive: true })
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${command} failed (${result.status ?? result.signal})`)
}
async function download(url, hash, algorithm, destination, archiveRoot) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw Error(`Tool download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash(algorithm).update(bytes).digest('hex') !== hash)
    throw Error(`Tool checksum mismatch: ${destination}`)
  const archive = join(tools, destination + '.tgz')
  await writeFile(archive, bytes)
  run('tar', ['-xf', archive, '-C', tools])
  await rm(join(tools, destination), { recursive: true, force: true })
  await rename(join(tools, archiveRoot), join(tools, destination))
  await rm(archive)
}
await download(
  'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz',
  '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  'sha256',
  'node',
  'node-v24.21.0-linux-x64'
)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const manager = /^pnpm@([\d.]+)\+sha512\.([a-f0-9]{128})$/.exec(pkg.packageManager)
if (!manager) throw Error('Expected a checksum-pinned pnpm packageManager')
await download(
  `https://registry.npmjs.org/pnpm/-/pnpm-${manager[1]}.tgz`,
  manager[2],
  'sha512',
  'pnpm',
  'package'
)
const cache = join(homedir(), '.cache', 'orca-cube')
await mkdir(cache, { recursive: true, mode: 0o700 })
const temporary = await mkdtemp(join(cache, 'build-'))
const node = join(tools, 'node/bin/node')
const pnpm = join(tools, 'pnpm/bin/pnpm.mjs')
const env = {
  ...process.env,
  PATH: `${tools}/node/bin:${tools}/pnpm:${process.env.PATH}`,
  TMPDIR: temporary,
  npm_config_cache: join(tools, 'npm-cache'),
  npm_config_jobs: '2',
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  ORCA_BACKGROUND_LAUNCH: '1',
  NODE_OPTIONS: '--max-old-space-size=2048',
  GOMAXPROCS: '2',
  RAYON_NUM_THREADS: '2'
}
try {
  run(
    node,
    [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(tools, 'store')],
    { env }
  )
  run(node, [pnpm, 'build:orcad'], { env })
  // The upstream web wrapper overrides NODE_OPTIONS with a larger heap.
  // Packages were already built by build:orcad; invoke the same Vite build directly.
  run(
    node,
    [
      '--max-old-space-size=2048',
      'node_modules/vite/bin/vite.js',
      'build',
      '--config',
      'vite.web.config.ts'
    ],
    { env }
  )
  run(node, ['config/scripts/verify-web-build.mjs'], { env })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log('Orca for Cube installed')
