import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

test(
  'terminal hangup shuts down the owned runtime before launcher exit',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-hangup-'))
    let launcher, runtimePid
    t.after(async () => {
      launcher?.kill('SIGKILL')
      if (runtimePid) {
        try {
          process.kill(runtimePid, 'SIGKILL')
        } catch {}
      }
      await rm(root, { recursive: true, force: true })
    })
    await mkdir(join(root, 'cube'))
    await mkdir(join(root, 'out/orcad'), { recursive: true })
    for (const file of ['start.mjs', 'launch.mjs', 'server.mjs']) {
      await copyFile(new URL(file, import.meta.url), join(root, 'cube', file))
    }
    const pidFile = join(root, 'runtime.pid')
    await writeFile(
      join(root, 'out/orcad/orcad.js'),
      `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    console.log(JSON.stringify({type:'orca_server_ready', boundEndpoint:'ws://127.0.0.1:1234', pairing:{available:true,url:'orca://pair?code='+Buffer.from(JSON.stringify({v:2,scope:'runtime',endpoint:'ws://127.0.0.1:1234',deviceToken:'secret',publicKeyB64:'key'})).toString('base64url')},health:{terminalDaemon:{selfTest:{ok:true}}}}));
    setInterval(()=>{},1000);
  `
    )
    const reserve = createServer()
    reserve.listen(0, '127.0.0.1')
    await once(reserve, 'listening')
    const port = reserve.address().port
    await new Promise((resolve) => reserve.close(resolve))
    launcher = spawn(process.execPath, [join(root, 'cube/start.mjs')], {
      env: { ...process.env, PORT: String(port), ORCA_CUBE_STATE_DIR: join(root, 'state') },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const exited = once(launcher, 'exit')
    await once(launcher.stdout, 'data', { signal: AbortSignal.timeout(5000) })
    runtimePid = Number(await readFile(pidFile, 'utf8'))
    launcher.kill('SIGHUP')
    const [code, signal] = await exited
    assert.equal(signal, null)
    assert.equal(code, 0)
    assert.throws(() => process.kill(runtimePid, 0), /ESRCH/)
  }
)
