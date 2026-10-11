import { closeSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'

const CUBE_WRAPPER_HEADER = '#!/bin/sh\n# Written by cubed (shell-wrappers.ts):'

export function isCubeInteractiveAgentWrapper(candidate: string): boolean {
  if (!['codex', 'claude', 'opencode'].includes(basename(candidate))) {
    return false
  }
  let fd: number | undefined
  try {
    fd = openSync(candidate, 'r')
    const header = Buffer.alloc(CUBE_WRAPPER_HEADER.length)
    readSync(fd, header, 0, header.length, 0)
    return header.toString('utf8') === CUBE_WRAPPER_HEADER
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}
