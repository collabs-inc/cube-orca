import { runtimeEnvironmentRevisionFailure } from '../../../../shared/runtime-environment-revision-guard'
import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import {
  assertActiveEnvironment,
  requireActiveEnvironment,
  resolveEnvironment
} from './web-runtime-session'
import { createWebUiApi } from './web-ui-api'

export function createWebWorkspaceCleanupApi(): PreloadApi['workspaceCleanup'] {
  const ui = createWebUiApi()
  const activeScans = new Map<string, ReturnType<typeof requireActiveEnvironment>>()
  return {
    scan: async (args = {}, onProgress) => {
      const environment = requireActiveEnvironment()
      const scanId = args.scanId ?? createBrowserUuid()
      activeScans.set(scanId, environment)
      try {
        const response = await callEnvironmentEnvelope<WorkspaceCleanupScanResult>(
          environment.id,
          'workspaceCleanup.scan',
          { ...args, scanId },
          120_000,
          environment.pairingRevision ?? environment.createdAt,
          environment.runtimeId ?? undefined
        )
        assertActiveEnvironment(environment.id)
        const stale = runtimeEnvironmentRevisionFailure(
          resolveEnvironment(environment.id),
          environment.pairingRevision ?? environment.createdAt,
          'workspaceCleanup.scan',
          environment.runtimeId ?? undefined
        )
        if (stale && !stale.ok) {
          throw new Error(stale.error.message)
        }
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        if (!response.result || !Array.isArray(response.result.candidates)) {
          throw new Error(
            'The Orca server did not return a workspace scan. Update the server and retry.'
          )
        }
        const result = {
          ...response.result,
          errors: response.result.errors.map((error) => ({
            ...error,
            executionHostId:
              error.executionHostId === 'local'
                ? toRuntimeExecutionHostId(environment.id)
                : error.executionHostId
          })),
          candidates: response.result.candidates.map((candidate) => ({
            ...candidate,
            executionHostId:
              candidate.executionHostId === 'local'
                ? toRuntimeExecutionHostId(environment.id)
                : candidate.executionHostId
          }))
        }
        onProgress?.({
          ...result,
          scanId,
          scannedWorktreeCount: result.candidates.length,
          totalWorktreeCount: result.candidates.length
        })
        return result
      } finally {
        if (activeScans.get(scanId) === environment) {
          activeScans.delete(scanId)
        }
      }
    },
    cancelScan: async (scanId) => {
      const environment = activeScans.get(scanId)
      if (!environment) {
        return false
      }
      const response = await callEnvironmentEnvelope<boolean>(
        environment.id,
        'workspaceCleanup.cancelScan',
        { scanId },
        15_000,
        environment.pairingRevision ?? environment.createdAt,
        environment.runtimeId ?? undefined
      )
      return response.ok && response.result
    },
    // Browser scans are live; desktop snapshots belong to a different host namespace.
    getCachedScan: async () => null,
    dismiss: async (args) => {
      const current = await ui.get()
      const dismissals = { ...current.workspaceCleanup?.dismissals }
      for (const [key, value] of Object.entries(dismissals)) {
        if (args.removedWorktreeIds?.includes(value.worktreeId)) {
          delete dismissals[key]
        }
      }
      for (const dismissal of args.dismissals ?? []) {
        dismissals[getWorkspaceCleanupCandidateIdentity(dismissal)] = dismissal
      }
      await ui.set({ workspaceCleanup: { ...current.workspaceCleanup, dismissals } })
    },
    clearDismissals: async () => {
      const current = await ui.get()
      await ui.set({ workspaceCleanup: { ...current.workspaceCleanup, dismissals: {} } })
    }
  }
}
