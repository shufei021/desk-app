/** In-memory workspace asset library for component specs; it records every Host write. */
import type {
  AssetCategory, AssetLibrary, SaveAssetInput, WorkspaceAsset, WorkspaceSummary,
} from '../src/client/assets.ts'

/** The only workspace the default fake library offers. */
export const TEST_WORKSPACE: WorkspaceSummary = { id: 'workspace-1', title: 'Story', path: 'C:/work/story' }

/** One recorded removal request. */
export interface RemovedAsset {
  /** Workspace whose folder was named. */
  readonly workspaceId: string
  /** Category folder that was named. */
  readonly category: AssetCategory
  /** Stored file name that was named. */
  readonly name: string
}

/** A fake library that keeps its images in memory and records the writes it received. */
export interface FakeAssetLibrary extends AssetLibrary {
  /** Payloads passed to `save`, in call order. */
  readonly saved: SaveAssetInput[]
  /** Removals passed to `remove`, in call order. */
  readonly removed: RemovedAsset[]
}

/** Initial state of one fake library. */
export interface FakeAssetLibraryOptions {
  /** Workspaces the library reports; defaults to {@link TEST_WORKSPACE}. */
  readonly workspaces?: readonly WorkspaceSummary[]
  /** Stored images keyed by workspace id. */
  readonly assets?: Readonly<Record<string, readonly WorkspaceAsset[]>>
}

/**
 * Build a writable in-memory asset library for component specs.
 * @param options - reported workspaces and their initial images.
 * @returns a library with the production seam plus the writes it received.
 */
export function createFakeAssetLibrary(options: FakeAssetLibraryOptions = {}): FakeAssetLibrary {
  const workspaces = options.workspaces ?? [TEST_WORKSPACE]
  const assets = new Map<string, WorkspaceAsset[]>(
    workspaces.map(workspace => [workspace.id, [...(options.assets?.[workspace.id] ?? [])]]),
  )
  const saved: SaveAssetInput[] = []
  const removed: RemovedAsset[] = []
  let sequence = 0

  return {
    saved, removed,
    workspaces: () => Promise.resolve([...workspaces]),
    list: workspaceId => Promise.resolve([...(assets.get(workspaceId) ?? [])]),
    save: (input) => {
      saved.push(input)
      sequence += 1
      const name = `${input.title}-${String(sequence)}.${input.mime.slice('image/'.length)}`
      const asset: WorkspaceAsset = {
        name,
        title: input.title,
        category: input.category,
        bytes: 3,
        modifiedAt: Date.UTC(2026, 10, 20, 8),
        url: `api/workspace-assets/file?id=${encodeURIComponent(name)}&workspace=${encodeURIComponent(input.workspaceId)}`,
      }
      assets.set(input.workspaceId, [...(assets.get(input.workspaceId) ?? []), asset])
      return Promise.resolve(asset)
    },
    remove: (workspaceId, category, name) => {
      removed.push({ workspaceId, category, name })
      const current = assets.get(workspaceId) ?? []
      assets.set(workspaceId, current.filter(asset => asset.name !== name || asset.category !== category))
      return Promise.resolve(true)
    },
  }
}
