import { defineMethod } from '../core'
import {
  WorkspaceCleanupScanParams,
  WorkspaceCleanupCancelParams
} from '../../../../shared/rpc-contract/workspace-cleanup-params'

const scans = new Map<string, AbortController>()
const broadScans = new Map<string, AbortController>()

export const WORKSPACE_CLEANUP_METHODS = [
  defineMethod({
    name: 'workspaceCleanup.scan',
    permission: 'workspace',
    params: WorkspaceCleanupScanParams,
    handler: async (params, { runtime, connectionId, signal }) => {
      if (!connectionId) {
        throw new Error('Workspace scans require a connected client')
      }
      const key = JSON.stringify([runtime.getRuntimeId(), connectionId, params.scanId])
      scans.get(key)?.abort()
      const controller = new AbortController()
      scans.set(key, controller)
      const broadKey = JSON.stringify([
        runtime.getRuntimeId(),
        connectionId,
        params.includeAllWorkspaces === true
      ])
      const broad = params.worktreeId === undefined && params.worktreeIds === undefined
      if (broad) {
        broadScans.get(broadKey)?.abort()
        broadScans.set(broadKey, controller)
      }
      const abort = (): void => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
      }
      try {
        return await runtime.scanWorkspaceCleanup(params, controller.signal)
      } finally {
        signal?.removeEventListener('abort', abort)
        if (broadScans.get(broadKey) === controller) {
          broadScans.delete(broadKey)
        }
        if (scans.get(key) === controller) {
          scans.delete(key)
        }
      }
    }
  }),
  defineMethod({
    name: 'workspaceCleanup.cancelScan',
    permission: 'workspace',
    params: WorkspaceCleanupCancelParams,
    handler: (params, { runtime, connectionId }) => {
      const controller = scans.get(
        JSON.stringify([runtime.getRuntimeId(), connectionId, params.scanId])
      )
      if (!controller || controller.signal.aborted) {
        return false
      }
      controller.abort()
      return true
    }
  })
]
