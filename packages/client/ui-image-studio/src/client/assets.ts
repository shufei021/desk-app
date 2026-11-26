/**
 * Workspace asset library for the image workspace: the `workspaceAssets` Remote
 * seam, the upload encoding of a user-selected image, and the conversion of one
 * stored asset back into an uploadable file.
 *
 * Stored bytes belong to a registered workspace's asset folders on the Host
 * disk. This module keeps no copy in the browser and writes no Session event; a
 * stored image reaches a provider only when the user attaches it as a reference
 * through the normal upload path.
 */

import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'

/** Category folder that groups a stored asset. */
export type AssetCategory = 'character' | 'scene' | 'prop'

/** One image stored in a workspace asset folder. */
export interface WorkspaceAsset {
  /** File name including its extension; unique within one category folder. */
  readonly name: string
  /** Display title: the file name without its extension. */
  readonly title: string
  /** Category folder that holds the file. */
  readonly category: AssetCategory
  /** File size in bytes. */
  readonly bytes: number
  /** Last modification instant in epoch milliseconds. */
  readonly modifiedAt: number
  /** Document-relative URL of the authenticated route that serves this file. */
  readonly url: string
}

/** One registered workspace the library can store images in. */
export interface WorkspaceSummary {
  /** Stable workspace id the Remote methods accept. */
  readonly id: string
  /** Display title of the workspace. */
  readonly title: string
  /** Absolute workspace directory that holds the asset folder. */
  readonly path: string
}

/** One image to store in a workspace asset folder. */
export interface SaveAssetInput {
  /** Registered workspace that receives the file. */
  readonly workspaceId: string
  /** Category folder that holds the file. */
  readonly category: AssetCategory
  /** Display title; the Host derives the file name and resolves a collision. */
  readonly title: string
  /** Canonical base64 image bytes without a `data:` prefix. */
  readonly data: string
  /** Declared media type: `image/png`, `image/jpeg`, or `image/webp`. */
  readonly mime: string
}

/** Persistence seam of the asset panel: read one workspace, write or remove one stored image. */
export interface AssetLibrary {
  /**
   * Read the workspaces the library can store images in.
   * @returns every registered workspace, in registry order.
   */
  workspaces(): Promise<WorkspaceSummary[]>
  /**
   * Read every image stored in one workspace's asset folders.
   * @param workspaceId - registered workspace whose asset folders are read.
   * @returns stored images in category then file-name order.
   */
  list(workspaceId: string): Promise<WorkspaceAsset[]>
  /**
   * Store one image in a workspace category folder.
   * @param input - workspace, category, display title, and canonical base64 bytes with their media type.
   * @returns the stored image as the Host reports it.
   */
  save(input: SaveAssetInput): Promise<WorkspaceAsset>
  /**
   * Remove one stored image.
   * @param workspaceId - registered workspace that holds the file.
   * @param category - category folder that holds the file.
   * @param name - stored file name including its extension.
   * @returns whether a regular file was removed.
   */
  remove(workspaceId: string, category: AssetCategory, name: string): Promise<boolean>
}

/** Exact generated Remote dependency, supplied by the registration's context.
 * The wire method is `removeAsset`; `remove` is reserved by the client namespace service.
 */
export type WorkspaceAssetsRemote = Pick<ClientRemote['workspaceAssets'], 'workspaces' | 'list' | 'save' | 'removeAsset'>

/** One upload-ready image: canonical base64 bytes and the media type they decode to. */
export interface AssetUpload {
  /** Canonical base64 image bytes without a `data:` prefix. */
  readonly data: string
  /** Declared media type of those bytes. */
  readonly mime: string
}

const STORAGE_FAILURE_CODE = 'ASSET_STORAGE_FAILED'

/** Base64 image data URL produced by `FileReader`; the group selects the file type. */
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
}

const FILE_NAME_UNSAFE = /[\\/:*?"<>|\u0000-\u001f]+/g

/**
 * Build the one failure every asset operation reports.
 * @param detail - English technical description of what failed.
 * @param cause - underlying transport or browser error, when one exists.
 * @returns the error with the shared asset-storage code; callers show localized copy instead.
 */
function assetFailure(detail: string, cause?: unknown): HarnessError {
  return cause === undefined
    ? new HarnessError(detail, STORAGE_FAILURE_CODE)
    : new HarnessError(detail, STORAGE_FAILURE_CODE, { cause })
}

/**
 * Run one Remote method and unwrap its result, reporting every failure with the shared code.
 * @param operation - Remote method name used in the failure message.
 * @param run - the Remote call to perform.
 * @returns the value the Host returned.
 * @throws {HarnessError} `ASSET_STORAGE_FAILED` when the call fails or the Host rejects it.
 */
async function remoteValue<T>(operation: string, run: () => Promise<RemoteResult<T>>): Promise<T> {
  let result: RemoteResult<T>
  try {
    result = await run()
  } catch (cause) {
    throw assetFailure(`direct-ai: workspaceAssets/${operation} failed`, cause)
  }
  if (!result.ok) throw assetFailure(`direct-ai: the Host rejected workspaceAssets/${operation}`, result.error)
  return result.value
}

/**
 * Create the production asset library over the generated `workspaceAssets` namespace.
 *
 * Every failure rejects with a `HarnessError` whose code is `ASSET_STORAGE_FAILED`,
 * whether the transport failed or the Host refused the request.
 * @param remote - the generated workspace asset namespace; it never receives an Agent context.
 * @returns a library reading and writing the asset folders of registered workspaces.
 */
export function createRemoteAssetLibrary(remote: WorkspaceAssetsRemote): AssetLibrary {
  return {
    workspaces: async () => remoteValue('workspaces', () => remote.workspaces()),
    list: async workspaceId => remoteValue('list', () => remote.list(workspaceId)),
    save: async input => remoteValue('save', () => remote.save(input)),
    remove: async (workspaceId, category, name) => remoteValue('removeAsset', () => remote.removeAsset(workspaceId, category, name)),
  }
}

/**
 * Derive the uploaded file name from an asset title.
 * @param title - displayed asset title.
 * @returns the sanitized title, or `asset` when nothing usable remains.
 */
function assetFileStem(title: string): string {
  const stem = title.replace(FILE_NAME_UNSAFE, ' ').trim()
  return stem === '' ? 'asset' : stem
}

/**
 * Read one user-selected image as the upload payload the Host accepts.
 * @param file - browser-selected file; only PNG, JPEG, and WebP are accepted.
 * @returns canonical base64 bytes without the `data:` prefix, plus their media type.
 * @throws {HarnessError} `ASSET_STORAGE_FAILED` when the file cannot be read or is not a supported image.
 */
export function readAssetUpload(file: File): Promise<AssetUpload> {
  return new Promise<AssetUpload>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(assetFailure('direct-ai: reading the selected asset produced no data URL'))
        return
      }
      const match = IMAGE_DATA_URL.exec(result)
      const mime = match?.[1]
      const data = match?.[2]
      if (mime === undefined || data === undefined) {
        reject(assetFailure('direct-ai: the selected asset file is not a PNG, JPEG, or WebP image'))
        return
      }
      resolve({ data, mime })
    }
    reader.onerror = () => {
      reject(assetFailure('direct-ai: could not read the selected asset file', reader.error))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Read one stored asset through its byte route as the file the reference-upload path accepts.
 * @param url - document-relative byte URL the Host reported for the asset.
 * @param title - displayed asset title, used as the file name without its extension.
 * @returns a PNG, JPEG, or WebP file carrying the asset title.
 * @throws {HarnessError} `ASSET_STORAGE_FAILED` when the bytes cannot be read or are not a supported image.
 */
export async function assetFileFromUrl(url: string, title: string): Promise<File> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw assetFailure('direct-ai: could not fetch the stored asset bytes', cause)
  }
  if (!response.ok) {
    throw assetFailure(`direct-ai: the Host answered ${String(response.status)} for the stored asset`)
  }
  let blob: Blob
  try {
    blob = await response.blob()
  } catch (cause) {
    throw assetFailure('direct-ai: could not read the stored asset response body', cause)
  }
  const extension = FILE_EXTENSIONS[blob.type]
  if (extension === undefined) {
    throw assetFailure('direct-ai: the stored asset is not a PNG, JPEG, or WebP image')
  }
  return new File([blob], `${assetFileStem(title)}.${extension}`, { type: blob.type })
}
