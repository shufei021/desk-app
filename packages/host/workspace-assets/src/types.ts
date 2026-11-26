/**
 * Public vocabulary of the workspace asset library: the product categories, one
 * stored image, the workspace entry a caller may bind to, and one upload.
 * Types only — this file carries no runtime code.
 * @module @deepseek-ai/dsh-workspace-assets/src/types
 */

/** Product categories the library stores, mapped to the `角色`, `场景`, and `道具` folders. */
export type WorkspaceAssetCategory = 'character' | 'scene' | 'prop'

/** One image already stored in a workspace asset folder. */
export interface WorkspaceAsset {
  /** File name including its extension; unique within one category folder. */
  readonly name: string
  /** Display title: the file name without its extension. */
  readonly title: string
  /** Category folder that holds the file. */
  readonly category: WorkspaceAssetCategory
  /** File size in bytes. */
  readonly bytes: number
  /** Last modification instant in epoch milliseconds. */
  readonly modifiedAt: number
  /** Document-relative URL of the authenticated byte route that serves this file. */
  readonly url: string
}

/** One registered workspace the library can store images in. */
export interface WorkspaceAssetWorkspace {
  /** Stable workspace id the Remote methods accept. */
  readonly id: string
  /** Display title of the workspace. */
  readonly title: string
  /** Absolute workspace directory that holds the asset folder. */
  readonly path: string
}

/** One image to store in a workspace asset folder. */
export interface SaveWorkspaceAssetInput {
  /** Registered workspace that receives the file. */
  readonly workspaceId: string
  /** Category folder that holds the file. */
  readonly category: WorkspaceAssetCategory
  /** Display title; sanitized into the file name and extended with a sequence on a name collision. */
  readonly title: string
  /** Canonical base64 image bytes without a `data:` prefix. */
  readonly data: string
  /** Declared media type: `image/png`, `image/jpeg`, or `image/webp`. */
  readonly mime: string
}
