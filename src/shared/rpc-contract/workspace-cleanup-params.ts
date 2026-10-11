import { z } from 'zod'
import { WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT } from '../workspace-cleanup'
const scanId = z.string().min(1).max(200)
const ids = z.array(z.string().min(1).max(8192)).max(WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
export const WorkspaceCleanupScanParams = z
  .object({
    scanId,
    worktreeId: z.string().min(1).max(8192).optional(),
    worktreeIds: ids.optional(),
    skipGitWorktreeIds: ids.optional(),
    includeAllWorkspaces: z.boolean().optional(),
    refreshActivity: z.boolean().optional()
  })
  .strict()
export const WorkspaceCleanupCancelParams = z.object({ scanId }).strict()
