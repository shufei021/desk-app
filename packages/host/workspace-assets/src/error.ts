/** Structured, path-free failures owned by the workspace asset library. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Stable failure classes; workspace paths and file names never appear in a message. */
export type WorkspaceAssetErrorCode =
  | 'WORKSPACE_ASSET_INVALID_INPUT'
  | 'WORKSPACE_ASSET_TOO_LARGE'
  | 'WORKSPACE_ASSET_STORAGE_FAILED'
  | 'WORKSPACE_ASSET_NOT_FOUND'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    WORKSPACE_ASSET_INVALID_INPUT: Record<string, never>
    WORKSPACE_ASSET_TOO_LARGE: Record<string, never>
    WORKSPACE_ASSET_STORAGE_FAILED: Record<string, never>
    WORKSPACE_ASSET_NOT_FOUND: Record<string, never>
  }
}

/** RemoteError retains HarnessError identity and preserves its stable code on the Gateway wire. */
export class WorkspaceAssetError extends RemoteError<WorkspaceAssetErrorCode> {
  /**
   * @param code - stable failure class.
   * @param message - actionable text that never contains a filesystem path.
   */
  constructor(code: WorkspaceAssetErrorCode, message: string) {
    super(code, message, {})
    this.name = 'WorkspaceAssetError'
  }
}
