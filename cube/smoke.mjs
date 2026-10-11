// Real repository/worktree/PTY acceptance through Cube's public WebSocket gateway.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { launchOrca } from './launch.mjs'
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const fixture = await mkdtemp(join(tmpdir(), 'orca-cube-smoke-'))
const home = join(fixture, 'home')
const repoPath = join(home, 'cube-smoke-repo')
const downloadBytes = Buffer.from(Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 256))
await mkdir(repoPath, { recursive: true })
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local/share'),
  ORCA_USER_DATA: join(home, 'state'),
  ORCA_BACKGROUND_LAUNCH: '1'
}
let app, pairing, worktree, terminal, browser, page, browserTarget
async function cli(args) {
  // Async is essential: this process also serves the gateway used by the CLI.
  const { stdout } = await exec(
    process.execPath,
    [join(root, 'out/orcad/out/cli/index.js'), ...args, '--pairing-code', pairing, '--json'],
    { env, timeout: 45000, maxBuffer: 4 * 1024 * 1024 }
  )
  const data = JSON.parse(stdout)
  assert.notEqual(data.ok, false, data.error?.message)
  return data.result
}
async function start(port = 0, runtime = 'electron') {
  app = await launchOrca({
    root,
    entry: join(root, runtime === 'node' ? 'out/orcad/orcad.js' : 'cube/electron.mjs'),
    port,
    state: env.ORCA_USER_DATA,
    env
  })
  const response = await fetch(`http://127.0.0.1:${app.port}/`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  pairing = response.headers.get('location').split('#pairing=')[1]
  assert.equal(
    JSON.parse(Buffer.from(pairing, 'base64url')).endpoint,
    `ws://127.0.0.1:${app.port}/cube/runtime`
  )
}
async function outputContains(nonce) {
  const deadline = Date.now() + 30000
  let lastRead
  while (Date.now() < deadline) {
    const result = await cli(['terminal', 'read', '--terminal', terminal.handle])
    lastRead = result.terminal
    if (result.terminal.tail.map(String).join('\n').includes(nonce)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error('Fixture terminal read:', JSON.stringify(lastRead))
  throw Error('Terminal did not produce the expected output')
}
try {
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Cube smoke'],
    ['config', 'user.email', 'cube-smoke@example.invalid']
  ])
    await exec('git', args, { cwd: repoPath, env })
  await writeFile(join(repoPath, 'hello.txt'), 'Cube integration smoke\n')
  await writeFile(join(repoPath, 'download-proof.bin'), downloadBytes)
  await exec('git', ['add', '.'], { cwd: repoPath, env })
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repoPath, env })
  await start(0, process.argv.includes('--migrate-node') ? 'node' : 'electron')
  const repo = (await cli(['repo', 'add', '--path', repoPath])).repo
  assert.ok(repo.id)
  worktree = (
    await cli([
      'worktree',
      'create',
      '--repo',
      `id:${repo.id}`,
      '--name',
      'cube-smoke',
      '--setup',
      'skip'
    ])
  ).worktree
  assert.ok(worktree.id)
  terminal = (await cli(['terminal', 'create', '--worktree', worktree.id])).terminal
  assert.ok(terminal.handle)
  // Split the marker so echoed input alone cannot satisfy the output check.
  const suffix = randomBytes(8).toString('hex')
  const marker = 'CUBE_PTY_' + suffix
  await cli([
    'terminal',
    'send',
    '--terminal',
    terminal.handle,
    '--text',
    `export CUBE_SMOKE_SESSION='${suffix}'; printf 'CUBE_PTY_%s\\n' \"$CUBE_SMOKE_SESSION\"`,
    '--enter'
  ])
  await outputContains(marker)
  console.log('PASS: repository, worktree and real PTY round trip through Cube gateway')
  await cli([
    'terminal',
    'send',
    '--terminal',
    terminal.handle,
    '--text',
    `orca skills get orca-cli --json >/dev/null && orca repo list --json >/dev/null && printf 'CUBE_CLI_%s\\n' "${suffix}"`,
    '--enter'
  ])
  await outputContains('CUBE_CLI_' + suffix)
  console.log('PASS: managed terminal resolves its Orca skills CLI')

  if (process.argv.includes('--browser')) {
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    // Tips appear asynchronously, including after reload. Dismiss them when
    // they obstruct an action rather than racing an immediate visibility check.
    await page.addLocatorHandler(page.getByRole('dialog'), async (dialog) => {
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    })
    page.on('pageerror', (error) => console.error('Browser page error:', error.message))
    await page.goto(`http://127.0.0.1:${app.port}/`)
    await page.getByText('cube-smoke-repo', { exact: false }).first().waitFor({ timeout: 60000 })
    assert.equal(new URL(page.url()).hash, '')
    await page.reload()
    await page.getByText('cube-smoke-repo', { exact: false }).first().waitFor({ timeout: 60000 })
    // Open the actual worktree and verify its terminal surface.
    await page
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(worktree.id)}]`)
      .first()
      .click()
    await page.locator('.xterm-screen').first().waitFor({ timeout: 30000 })
    await page.screenshot({ path: join(root, 'cube-smoke.png'), fullPage: true })
    console.log('PASS: real web client pairing, terminal rendering and reload')
    await page
      .getByRole('button', { name: 'download-proof.bin', exact: true })
      .click({ button: 'right' })
    const downloadEvent = page.waitForEvent('download', { timeout: 30000 })
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click()
    const download = await downloadEvent
    const downloadedPath = join(fixture, 'downloaded.bin')
    await download.saveAs(downloadedPath)
    assert.equal(await download.failure(), null)
    assert.equal(download.suggestedFilename(), 'download-proof.bin')
    assert.deepEqual(await readFile(downloadedPath), downloadBytes)
    console.log('PASS: browser file download preserves multi-chunk binary bytes')
    await page.removeLocatorHandler(page.getByRole('dialog'))
    await page.getByRole('button', { name: 'Onboarding checklist' }).click()
    await page.getByRole('button', { name: /Give agents Orca skills/ }).click()
    await page.getByRole('button', { name: 'Install skills', exact: true }).click()
    const setup = page.getByRole('region', { name: 'Skill setup command' })
    await setup.locator('[data-pty-id]').waitFor({ timeout: 30000 })
    await page.waitForFunction(
      () => {
        const setup = document.querySelector('[aria-label="Skill setup command"]')
        return setup?.querySelector('.xterm-rows')?.textContent?.includes('npx')
      },
      undefined,
      { timeout: 30000 }
    )
    await page.screenshot({ path: join(root, 'cube-onboarding.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    console.log('PASS: onboarding setup terminal starts and receives the install draft')
    browserTarget = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        '<!doctype html><title>Cube browser acceptance</title><h1>Cube browser acceptance</h1><button onclick="this.textContent=String(Number(this.textContent)+1)">0</button><input aria-label="Test input">'
      )
    })
    await new Promise((resolve) => browserTarget.listen(0, '127.0.0.1', resolve))
    const targetUrl = `http://127.0.0.1:${browserTarget.address().port}/`
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    await page.getByText('New Browser Tab', { exact: false }).click()
    await page.keyboard.press('Escape')
    const address = page.getByTestId('remote-browser-pane').getByRole('combobox')
    await address.fill(targetUrl)
    await address.press('Enter')
    await page.getByTestId('remote-browser-frame').waitFor({ timeout: 30000 })
    const tabHandle = await page.waitForFunction(
      async (url) => {
        const response = await window.api.runtime.call({ method: 'browser.tabList', params: {} })
        return response.result?.tabs?.find((tab) => tab.url === url)?.browserPageId
      },
      targetUrl,
      { timeout: 30000 }
    )
    const browserPageId = await tabHandle.jsonValue()
    const geometryResponse = await page.evaluate(
      (id) =>
        window.api.runtime.call({
          method: 'browser.eval',
          params: {
            page: id,
            expression:
              'JSON.stringify({width:innerWidth,height:innerHeight,button:document.querySelector("button").getBoundingClientRect().toJSON(),input:document.querySelector("input").getBoundingClientRect().toJSON()})'
          }
        }),
      browserPageId
    )
    assert.equal(geometryResponse.ok, true)
    const geometry = JSON.parse(geometryResponse.result.result)
    const frame = page.getByTestId('remote-browser-frame')
    const bounds = await frame.boundingBox()
    for (const rect of [geometry.button, geometry.input]) {
      await frame.click({
        position: {
          x: ((rect.x + rect.width / 2) * bounds.width) / geometry.width,
          y: ((rect.y + rect.height / 2) * bounds.height) / geometry.height
        }
      })
    }
    await page.keyboard.type('Cube browser input')
    const verifyBrowserInput = () =>
      page.waitForFunction(
        async (id) => {
          const response = await window.api.runtime.call({
            method: 'browser.eval',
            params: {
              page: id,
              expression:
                'JSON.stringify({count:document.querySelector("button").textContent,input:document.querySelector("input").value})'
            }
          })
          if (!response.ok) return false
          const state = JSON.parse(response.result.result)
          return state.count === '1' && state.input === 'Cube browser input'
        },
        browserPageId,
        { timeout: 15000 }
      )
    await verifyBrowserInput()
    await page.reload()
    // Web rebuilds live tabs from the runtime after reload; it deliberately
    // discards persisted remote selection handles. Reopen the retained page.
    await page.getByText('Cube browser acceptance', { exact: true }).click()
    await page.getByTestId('remote-browser-frame').waitFor({ timeout: 30000 })
    await verifyBrowserInput()
    console.log('PASS: browser stream, mouse, keyboard, and web reload')
  }
  const port = app.port
  await app.stop()
  await start(port)
  assert.equal(
    (await cli(['worktree', 'show', '--worktree', worktree.id])).worktree.id,
    worktree.id
  )
  // A UI attachment can replace the runtime's short output snapshot. Prove
  // process continuity with shell state, not a historical preview line.
  await cli([
    'terminal',
    'send',
    '--terminal',
    terminal.handle,
    '--text',
    `printf 'CUBE_RESUMED_%s\\n' "$CUBE_SMOKE_SESSION"`,
    '--enter'
  ])
  await outputContains('CUBE_RESUMED_' + suffix)
  if (page) {
    await page.goto(`http://127.0.0.1:${app.port}/`)
    await page.getByText('cube-smoke-repo', { exact: false }).first().waitFor({ timeout: 60000 })
  }
  console.log('PASS: worktree and terminal persist across runtime restart')
} finally {
  if (page)
    await page.screenshot({ path: join(root, 'cube-smoke.png'), fullPage: true }).catch(() => {})
  await browser?.close()
  browserTarget?.closeAllConnections()
  browserTarget?.close()
  let cleaned = true
  if (app && worktree) {
    await cli(['worktree', 'rm', '--worktree', worktree.id, '--force']).catch((error) => {
      cleaned = false
      console.error('Smoke cleanup failed:', error.message)
      process.exitCode = 1
    })
  }
  await app?.stop()
  if (cleaned) await rm(fixture, { recursive: true, force: true })
  else console.error(`Retained fixture state for terminal cleanup: ${fixture}`)
}
