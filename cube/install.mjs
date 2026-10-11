// Cube integration: build the web UI and full headless Electron runtime.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, mkdtemp, copyFile } from 'node:fs/promises'
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
// Private Debian 12 libraries, including their packaged copyright notices.
// Cube supplies Xvfb and the remaining base Chromium dependencies.
const libraries = [
  [
    'g/gtk+3.0/libgtk-3-0_3.24.38-2~deb12u3_amd64.deb',
    '0ff7375c98b5a8d6aafc6096b21d9f7bae4ecb581d31fce5d37be18f55b489a2'
  ],
  [
    'libe/libepoxy/libepoxy0_1.5.10-1_amd64.deb',
    '050cbedc9c2a5cce976151c720a3817f2103a01e6ac255bdd6f2c6a7509b04c3'
  ],
  [
    'w/wayland/libwayland-client0_1.21.0-1_amd64.deb',
    '1f002d028b8b79eec9847c636d8886d10dfe8c884cc2bebe18086b1391c5a28d'
  ],
  [
    'w/wayland/libwayland-cursor0_1.21.0-1_amd64.deb',
    '0b684467ec795024fcaae99ea4384959cc4052b2da5adec38c9b76dfed9bcf41'
  ],
  [
    'w/wayland/libwayland-egl1_1.21.0-1_amd64.deb',
    'cb4225f0e15e00a3570d4cbc288c87ff477d73e741c3f1c5a6d47cf350d45378'
  ],
  [
    'libx/libxcursor/libxcursor1_1.2.1-1_amd64.deb',
    '49e167048661be4c614fff81429e9eaef38e54ef1d2150a5d2a8c53919217529'
  ],
  [
    'libx/libxinerama/libxinerama1_1.1.4-3_amd64.deb',
    '8dde8f74d2fc001f306fb1295a86850145e93191d35c983c7f52eb21b0a7f8cb'
  ]
]
for (const [path, hash] of libraries) {
  const response = await fetch(`https://deb.debian.org/debian/pool/main/${path}`, {
    signal: AbortSignal.timeout(120000)
  })
  if (!response.ok) throw Error(`Runtime library download failed (${response.status}): ${path}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== hash)
    throw Error(`Runtime library checksum mismatch: ${path}`)
  const archive = join(tools, 'runtime-library.deb')
  await writeFile(archive, bytes)
  run('dpkg-deb', ['-x', archive, join(tools, 'linux-libs')])
  await rm(archive)
}
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
  const electronEnv = {
    ...env,
    LD_LIBRARY_PATH: [join(tools, 'linux-libs/usr/lib/x86_64-linux-gnu'), env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(':')
  }
  delete electronEnv.ELECTRON_SKIP_BINARY_DOWNLOAD
  delete electronEnv.ELECTRON_RUN_AS_NODE
  run(node, ['node_modules/electron/install.js'], { env: electronEnv })
  run(node, ['config/scripts/ensure-native-runtime.mjs', '--runtime=electron'], {
    env: electronEnv
  })
  for (const target of ['main', 'preload', 'renderer']) {
    run(
      node,
      [
        'node_modules/electron-vite/bin/electron-vite.js',
        'build',
        '--config',
        'config/electron-vite-target.config.cts',
        '--ignoreConfigWarning'
      ],
      {
        env: { ...electronEnv, ORCA_ELECTRON_VITE_TARGET: target }
      }
    )
  }
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
  // Electron's development launcher expects out/cli; reuse the bundled CLI
  // built for orcad rather than leaving managed agents without the orca command.
  await mkdir(join(root, 'out/cli'), { recursive: true })
  await copyFile(join(root, 'out/orcad/out/cli/index.js'), join(root, 'out/cli/index.js'))
  await copyFile(join(root, 'out/orcad/out/package.json'), join(root, 'out/package.json'))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log('Orca for Cube installed')
