import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import {
  accessSync,
  statSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  symlinkSync,
  renameSync,
  readFileSync,
  writeFileSync,
  readlinkSync,
  lstatSync,
  unlinkSync
} from 'node:fs'

function isCubeWrapper(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(64)
    readSync(fd, header, 0, header.length, 0)
    return header.toString().startsWith('#!/bin/sh\n# Written by cubed (shell-wrappers.ts):')
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function managedAgentPath(state, path) {
  if (!path) return path
  const directory = resolve(state, 'cli', 'bin')
  const record = join(directory, '.cube-managed-agents.json')
  const agents = ['codex', 'claude', 'opencode']
  let previous = {}
  try {
    const data = JSON.parse(readFileSync(record, 'utf8'))
    for (const agent of agents) if (typeof data?.[agent] === 'string') previous[agent] = data[agent]
  } catch {}
  const directories = path
    .split(':')
    .filter(Boolean)
    .map((entry) => resolve(entry))
    .filter((entry) => entry !== directory)
  const overrides = {}
  for (const agent of agents) {
    const candidates = directories
      .map((entry) => join(entry, agent))
      .filter((candidate) => {
        try {
          accessSync(candidate, constants.X_OK)
          return statSync(candidate).isFile()
        } catch {
          return false
        }
      })
    if (!candidates.length || !isCubeWrapper(candidates[0])) continue
    const executable = candidates.find((candidate) => !isCubeWrapper(candidate))
    if (executable) overrides[agent] = executable
  }
  const owned = (agent) => {
    try {
      return (
        previous[agent] !== undefined && readlinkSync(join(directory, agent)) === previous[agent]
      )
    } catch {
      return false
    }
  }
  for (const agent of agents) {
    if (previous[agent] && !overrides[agent] && owned(agent)) unlinkSync(join(directory, agent))
  }
  const current = {}
  for (const [agent, executable] of Object.entries(overrides)) {
    const destination = join(directory, agent)
    try {
      lstatSync(destination)
      if (!owned(agent)) continue
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `${agent}.${process.pid}`)
    symlinkSync(executable, temporary)
    renameSync(temporary, destination)
    current[agent] = executable
  }
  if (Object.keys(current).length || Object.keys(previous).length) {
    const temporary = `${record}.${process.pid}`
    writeFileSync(temporary, JSON.stringify(current), { mode: 0o600 })
    renameSync(temporary, record)
  }
  // Orca re-prepends this CLI directory after login-shell startup files reset PATH.
  // Keep Cube's URL openers in their original position; override only its agent wrappers.
  return Object.keys(current).length ? `${directory}:${path}` : path
}

export function electronServeEnvironment(root, state, display, inherited = process.env) {
  const env = {
    ...inherited,
    DISPLAY: display,
    PATH: managedAgentPath(state, inherited.PATH),
    ORCA_DEV_USER_DATA_PATH: state,
    ORCA_SERVE_USER_DATA_PATH: state,
    ORCA_USER_DATA: state,
    ORCA_BACKGROUND_LAUNCH: '1',
    LD_LIBRARY_PATH: [
      join(root, 'cube/tools/linux-libs/usr/lib/x86_64-linux-gnu'),
      inherited.LD_LIBRARY_PATH
    ]
      .filter(Boolean)
      .join(':')
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'ORCA_E2E_USER_DATA_DIR',
    'ORCA_E2E_HOME_DIR'
  ])
    delete env[key]
  return env
}

function observeExit(child) {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
}
async function terminate(child, exited) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  timer.unref()
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

export async function launchElectronServe({
  root,
  state,
  env = process.env,
  signal,
  displayExecutable = '/usr/bin/Xvfb',
  electronExecutable = join(root, 'node_modules/electron/dist/electron')
}) {
  signal?.throwIfAborted()
  const display = spawn(
    displayExecutable,
    ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] }
  )
  const displayExit = observeExit(display)
  let child,
    childExit,
    closed,
    stopping = false,
    displayFailed = false
  const stop = async () => {
    stopping = true
    if (child) await terminate(child, childExit)
    await terminate(display, displayExit)
    await closed
  }
  const abort = () => void stop()
  signal?.addEventListener('abort', abort, { once: true })
  display.on('error', () => {})
  display.once('exit', () => {
    if (!stopping) {
      displayFailed = true
      if (child) void terminate(child, childExit)
    }
  })
  try {
    const number = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => finish(Error('Virtual display did not become ready')), 10000)
      const finish = (error, value) => {
        clearTimeout(timer)
        display.off('error', fail)
        display.off('exit', exited)
        display.stdio[3].off('data', data)
        error ? reject(error) : resolve(value)
      }
      const fail = (error) => finish(error)
      const exited = () => finish(Error('Virtual display exited before readiness'))
      const data = (bytes) => {
        buffer += bytes.toString()
        if (!buffer.includes('\n')) return
        const value = buffer.trim()
        if (!/^\d+$/.test(value)) finish(Error('Invalid virtual display number'))
        else finish(null, value)
      }
      display.once('error', fail)
      display.once('exit', exited)
      display.stdio[3].on('data', data)
    })
    signal?.throwIfAborted()
    if (displayFailed) throw Error('Virtual display exited during startup')
    child = spawn(
      electronExecutable,
      [
        root,
        '--serve',
        '--serve-port',
        '0',
        '--serve-bind',
        '127.0.0.1',
        '--serve-json',
        `--user-data-dir=${state}`
      ],
      {
        cwd: root,
        env: electronServeEnvironment(root, state, `:${number}`, env),
        stdio: ['ignore', 'inherit', 'inherit']
      }
    )
    childExit = observeExit(child)
    await once(child, 'spawn')
    closed = childExit.then(async ({ code }) => {
      signal?.removeEventListener('abort', abort)
      const result = stopping ? 0 : displayFailed ? 1 : (code ?? 1)
      stopping = true
      await terminate(display, displayExit)
      return result
    })
    signal?.throwIfAborted()
    return { pid: child.pid, displayPid: display.pid, closed, stop }
  } catch (error) {
    signal?.removeEventListener('abort', abort)
    await stop()
    throw error
  }
}
