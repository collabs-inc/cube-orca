import { homedir } from 'node:os'
import { resolveLoginShellGrokHome, resolveLoginShellKiroHome } from './agent-home-login-shell'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

export async function installManagedHooks(options?: {
  signal?: AbortSignal
  hostKeyFingerprint?: string
  agents?: readonly AgentHookTarget[]
  claudeVersion?: string
}): Promise<ManagedHookInstallSummary> {
  options?.signal?.throwIfAborted()
  // Why: empty/omitted allowlist fails closed before any home/host probes.
  const agents = options?.agents ?? []
  if (agents.length === 0) {
    return { installers: 0, errors: 0 }
  }
  const home = homedir()
  // Why parallel: each probe may wait out its own login-shell timeout.
  const [grokHomeDir, kiroHomeDir] = await Promise.all([
    agents.includes('grok') ? resolveLoginShellGrokHome(home, options?.signal) : undefined,
    agents.includes('kiro') ? resolveLoginShellKiroHome(home, options?.signal) : undefined
  ])
  options?.signal?.throwIfAborted()
  const hostIdentity = scopeManagedHookHostIdentity(
    await readManagedHookHostIdentity(),
    options?.hostKeyFingerprint
  )
  return await withManagedHookInstallLock(
    home,
    options?.signal,
    async () => {
      const results = await installRemoteManagedAgentHooks(
        createManagedHookLocalFilesystem(),
        home,
        {
          grokHomeDir,
          kiroHomeDir,
          signal: options?.signal,
          agents,
          ...(options?.claudeVersion ? { claudeVersion: options.claudeVersion } : {})
        }
      )
      return {
        installers: results.length,
        errors: results.filter((result) => result.state === 'error').length
      }
    },
    hostIdentity
  )
}
