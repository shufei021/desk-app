/**
 * Per-workspace image asset folders on the Host disk: the `workspaceAssets`
 * Remote namespace and the authenticated byte route that serves stored files.
 * @module @deepseek-ai/dsh-workspace-assets
 */

import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { configSchema, type Config } from './config.ts'
import { WorkspaceAssetError } from './error.ts'
import {
  CATEGORIES, CATEGORY_DIRECTORIES, assetFileStem, containedPath, errorCode, extensionForMime,
  isAssetFileName, isCategory, isFolderName, mimeForName,
} from './library.ts'
import type {
  SaveWorkspaceAssetInput, WorkspaceAsset, WorkspaceAssetCategory, WorkspaceAssetWorkspace,
} from './types.ts'

export type * from './types.ts'
export type { Config } from './config.ts'
export { WorkspaceAssetError } from './error.ts'

/** Exact path of the byte route on the shared API channel. */
const FILE_ROUTE = '/api/workspace-assets/file'

/** The same route as a document-relative URL, so proxy prefixes and Desktop delivery keep working. */
const FILE_URL = FILE_ROUTE.slice(1)

/** Attempts at an unused file name before the save is refused. */
const MAX_NAME_ATTEMPTS = 20

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-workspace image asset folders and the byte route that serves them. */
    workspaceAssets: WorkspaceAssets
  }
}

/**
 * Decode one upload and enforce the per-file limit.
 * @param data - declared canonical base64 without a `data:` prefix.
 * @param limit - maximum accepted byte length.
 * @returns the decoded image bytes.
 * @throws {WorkspaceAssetError} `WORKSPACE_ASSET_INVALID_INPUT` for a non-canonical or empty payload,
 * and `WORKSPACE_ASSET_TOO_LARGE` above the limit.
 */
function decodeAssetData(data: string, limit: number): Buffer {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Assets must use canonical base64 without a data prefix.')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) {
    throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Assets must use canonical base64 without a data prefix.')
  }
  if (bytes.byteLength > limit) {
    throw new WorkspaceAssetError('WORKSPACE_ASSET_TOO_LARGE', 'The image exceeds the configured asset byte limit.')
  }
  return bytes
}

/** One storage failure whose message names no path. */
function storageFailure(): WorkspaceAssetError {
  return new WorkspaceAssetError('WORKSPACE_ASSET_STORAGE_FAILED', 'The workspace asset folder could not be accessed.')
}

/** Uniform miss response: no path, reason, or filesystem detail is disclosed. */
function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
}

/** Store and serve images inside one folder per workspace. */
export default class WorkspaceAssets extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'connection']
  static Config = configSchema
  private readonly config: Config

  /**
   * @param ctx - owning Host context; Connection must already provide exact Fetch routes.
   * @param config - folder name and byte limit; schema defaults apply when omitted.
   */
  constructor(ctx: Context, config: Config = configSchema({})) {
    super(ctx, 'workspaceAssets')
    this.config = configSchema(config)
    if (!isFolderName(this.config.folderName)) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'The asset folder name must be one path segment.')
    }
    // Connection's exact route dispatcher authenticates and checks owner before this handler runs.
    ctx.connection.fetch.register({
      path: FILE_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => this.fileResponse(request),
    })
  }

  /** List registered workspaces the library can store images in.
   * @returns stable id, display title, and absolute directory of every workspace, in registry order.
   */
  @Remote
  workspaces(): Promise<WorkspaceAssetWorkspace[]> {
    return Promise.resolve(this.ctx.workspaceRegistry.list().map(workspace => ({
      id: workspace.id, title: workspace.title, path: workspace.path,
    })))
  }

  /** List the images stored in one workspace.
   * @param workspaceId - registered workspace whose asset folder is read.
   * @returns stored images in category then file-name order; a workspace without the folder has an empty library.
   */
  @Remote
  async list(workspaceId: string): Promise<WorkspaceAsset[]> {
    const workspace = this.workspace(workspaceId)
    const assets: WorkspaceAsset[] = []
    for (const category of CATEGORIES) {
      const directory = this.directory(workspace, category)
      for (const name of await this.imageNames(directory)) {
        const info = await this.info(join(directory, name))
        if (info === undefined || info.isSymbolicLink() || !info.isFile()) continue
        assets.push(this.asset(category, workspace, name, info))
      }
    }
    return assets
  }

  /** Store one image in a workspace category folder.
   * The title is sanitized into the file name; a taken name gains `-2`, `-3`, and so on.
   * @param input - workspace, category, display title, and canonical base64 image bytes with their media type.
   * @returns the stored image as the listing reports it.
   */
  @Remote
  async save(input: SaveWorkspaceAssetInput): Promise<WorkspaceAsset> {
    const workspace = this.workspace(input.workspaceId)
    if (!isCategory(input.category)) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Asset category is invalid.')
    }
    const extension = extensionForMime(input.mime)
    if (extension === undefined) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Assets must be PNG, JPEG, or WebP images.')
    }
    const data = decodeAssetData(input.data, this.config.maxAssetBytes)
    const directory = this.directory(workspace, input.category)
    await this.prepare(directory)
    const stem = assetFileStem(input.title)
    for (let sequence = 1; sequence <= MAX_NAME_ATTEMPTS; sequence += 1) {
      const name = `${stem}${sequence === 1 ? '' : `-${sequence}`}${extension}`
      const path = this.file(workspace, input.category, name)
      if (!(await this.create(path, data))) continue
      const info = await this.info(path)
      if (info === undefined) throw storageFailure()
      return this.asset(input.category, workspace, name, info)
    }
    throw new WorkspaceAssetError('WORKSPACE_ASSET_STORAGE_FAILED', 'No unused asset file name was available.')
  }

  /** Remove one stored image.
   * The endpoint is `removeAsset`, not `remove`: a mounted client namespace reserves `remove` for its own bookkeeping.
   * @param workspaceId - registered workspace that holds the file.
   * @param category - category folder that holds the file.
   * @param name - stored file name, extension included, exactly as the listing reports it.
   * @returns `true` when a regular file was removed, `false` when there was none.
   */
  @Remote
  async removeAsset(workspaceId: string, category: WorkspaceAssetCategory, name: string): Promise<boolean> {
    const workspace = this.workspace(workspaceId)
    if (!isCategory(category)) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Asset category is invalid.')
    }
    const path = this.file(workspace, category, name)
    const info = await this.info(path)
    if (info === undefined || info.isSymbolicLink() || !info.isFile()) return false
    try {
      await unlink(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw storageFailure()
    }
    return true
  }

  /** Resolve one registered workspace by its wire id. */
  private workspace(id: string): Workspace {
    // The wire carries a plain string; it becomes a WorkspaceId at this boundary.
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(id))
    if (workspace === undefined) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_NOT_FOUND', 'Workspace was not found.')
    }
    return workspace
  }

  /** Absolute category folder, refused when the configuration would leave the workspace. */
  private directory(workspace: Workspace, category: WorkspaceAssetCategory): string {
    const path = containedPath(workspace.path, [this.config.folderName, CATEGORY_DIRECTORIES[category]])
    if (path === undefined) throw storageFailure()
    return path
  }

  /** Absolute file path for one stored name, refused unless the name is exactly what the library writes. */
  private file(workspace: Workspace, category: WorkspaceAssetCategory, name: string): string {
    if (!isAssetFileName(name)) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Asset file name is invalid.')
    }
    const path = containedPath(workspace.path, [this.config.folderName, CATEGORY_DIRECTORIES[category], name])
    if (path === undefined) {
      throw new WorkspaceAssetError('WORKSPACE_ASSET_INVALID_INPUT', 'Asset file name is invalid.')
    }
    return path
  }

  /** Create the category folder on demand and confirm it is a real directory rather than a link. */
  private async prepare(directory: string): Promise<void> {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    } catch (_directoryUnavailable) {
      throw storageFailure()
    }
    const info = await this.info(directory)
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) throw storageFailure()
  }

  /** Regular-file names the library would serve in one category folder, sorted by name. */
  private async imageNames(directory: string): Promise<string[]> {
    const info = await this.info(directory)
    // A missing, linked, or non-directory asset folder is an empty library, never an error to report.
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) return []
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw storageFailure()
    }
    return entries
      .filter(entry => entry.isFile() && isAssetFileName(entry.name))
      .map(entry => entry.name)
      .sort()
  }

  /** `lstat` that reports an absent path as undefined and every other failure as a storage error. */
  private async info(path: string): Promise<Stats | undefined> {
    try {
      return await lstat(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw storageFailure()
    }
  }

  /** Create one file exclusively; false means another file already holds that name. */
  private async create(path: string, data: Buffer): Promise<boolean> {
    let file: FileHandle
    try {
      file = await open(path, 'wx', 0o600)
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false
      throw storageFailure()
    }
    try {
      await file.writeFile(data)
    } catch (_writeFailed) {
      await file.close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw storageFailure()
    }
    await file.close()
    return true
  }

  /** Public projection of one regular file. */
  private asset(
    category: WorkspaceAssetCategory, workspace: Workspace, name: string, info: Stats,
  ): WorkspaceAsset {
    return {
      name,
      title: name.slice(0, name.lastIndexOf('.')),
      category,
      bytes: info.size,
      modifiedAt: info.mtimeMs,
      url: `${FILE_URL}?id=${encodeURIComponent(name)}&workspace=${encodeURIComponent(workspace.id)}`
        + `&category=${category}`,
    }
  }

  /** Serve one stored image, answering 404 for every request that does not name a regular stored file. */
  private async fileResponse(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const workspaceId = url.searchParams.get('workspace')
      const category = url.searchParams.get('category')
      const name = url.searchParams.get('id')
      if (workspaceId === null || category === null || name === null || !isCategory(category)) return notFound()
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
      if (workspace === undefined) return notFound()
      const path = this.file(workspace, category, name)
      const info = await this.info(path)
      if (info === undefined || info.isSymbolicLink() || !info.isFile()
        || info.size > this.config.maxAssetBytes) return notFound()
      const headers = {
        'content-type': mimeForName(name) ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      }
      if (request.method === 'HEAD') return new Response(null, { headers })
      const bytes = await readFile(path, { signal: request.signal })
      return new Response(new Uint8Array(bytes).buffer, { headers })
    } catch (_unusableAssetRequest) {
      return notFound()
    }
  }
}
