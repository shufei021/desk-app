// @vitest-environment jsdom
/** Workspace asset seam: Remote passthrough, upload encoding, byte-URL conversion and failure reporting. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  assetFileFromUrl, createRemoteAssetLibrary, readAssetUpload,
  type WorkspaceAsset, type WorkspaceAssetsRemote, type WorkspaceSummary,
} from '../src/client/assets.ts'

const WORKSPACE: WorkspaceSummary = { id: 'workspace-1', title: 'Story', path: 'C:/work/story' }
const ASSET: WorkspaceAsset = {
  name: 'Hero.png',
  title: 'Hero',
  category: 'character',
  bytes: 3,
  modifiedAt: Date.UTC(2026, 10, 20, 8),
  url: 'api/workspace-assets/file?id=Hero.png&workspace=workspace-1&category=character',
}

/** Build the generated namespace with the defaults a passing Host would answer. */
function remoteDefaults() {
  return {
    workspaces: vi.fn<WorkspaceAssetsRemote['workspaces']>(async () => ({ ok: true, value: [WORKSPACE] })),
    list: vi.fn<WorkspaceAssetsRemote['list']>(async () => ({ ok: true, value: [ASSET] })),
    save: vi.fn<WorkspaceAssetsRemote['save']>(async input => ({
      ok: true, value: { ...ASSET, name: `${input.title}.png`, title: input.title, category: input.category },
    })),
    removeAsset: vi.fn<WorkspaceAssetsRemote['removeAsset']>(async () => ({ ok: true, value: true })),
  }
}

/** Build the generated namespace, replacing the methods this test needs to fail. */
function remoteWith(overrides: Partial<WorkspaceAssetsRemote> = {}): WorkspaceAssetsRemote {
  return { ...remoteDefaults(), ...overrides }
}

/** Await one rejection and return the HarnessError it failed with. */
async function rejected(run: Promise<unknown>): Promise<HarnessError> {
  try {
    await run
  } catch (error) {
    if (error instanceof HarnessError) return error
    throw error
  }
  throw new Error('expected the asset operation to fail')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('remote asset library', () => {
  it('passes the workspace list through the workspaceAssets namespace', async () => {
    const remote = remoteDefaults()
    const library = createRemoteAssetLibrary(remote)
    await expect(library.workspaces()).resolves.toEqual([WORKSPACE])
    expect(remote.workspaces).toHaveBeenCalledWith()
  })

  it('lists one workspace by the id the caller names', async () => {
    const remote = remoteDefaults()
    const library = createRemoteAssetLibrary(remote)
    await expect(library.list('workspace-2')).resolves.toEqual([ASSET])
    expect(remote.list).toHaveBeenCalledWith('workspace-2')
  })

  it('saves the upload payload the panel built', async () => {
    const remote = remoteDefaults()
    const library = createRemoteAssetLibrary(remote)
    const input = { workspaceId: 'workspace-1', category: 'prop' as const, title: 'Sword', data: 'AQID', mime: 'image/png' }
    await expect(library.save(input)).resolves.toMatchObject({ title: 'Sword', category: 'prop' })
    expect(remote.save).toHaveBeenCalledWith(input)
  })

  it('removes the named file inside its category folder', async () => {
    const remote = remoteDefaults()
    remote.removeAsset.mockResolvedValueOnce({ ok: true, value: false })
    const library = createRemoteAssetLibrary(remote)
    await expect(library.remove('workspace-1', 'prop', 'Sword.png')).resolves.toBe(false)
    expect(remote.removeAsset).toHaveBeenCalledWith('workspace-1', 'prop', 'Sword.png')
  })

  it('reports a Host refusal as an asset storage failure', async () => {
    const remote = remoteWith({
      list: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'asset folder unreadable', {}) }),
    })
    const failure = await rejected(createRemoteAssetLibrary(remote).list('workspace-1'))
    expect(failure).toBeInstanceOf(HarnessError)
    expect(failure.code).toBe('ASSET_STORAGE_FAILED')
    expect(failure.message).toMatch(/workspaceAssets\/list/)
  })

  it('reports a transport rejection as an asset storage failure', async () => {
    const remote = remoteWith({
      workspaces: async () => { throw new Error('connection closed') },
    })
    const failure = await rejected(createRemoteAssetLibrary(remote).workspaces())
    expect(failure.code).toBe('ASSET_STORAGE_FAILED')
    expect(failure.message).toMatch(/workspaceAssets\/workspaces/)
  })
})

describe('asset upload encoding', () => {
  it('strips the data URL prefix and keeps the media type', async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], 'hero.png', { type: 'image/png' })
    await expect(readAssetUpload(file)).resolves.toEqual({ data: 'AQID', mime: 'image/png' })
  })

  it('reports a selected file that is not a supported image', async () => {
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const failure = await rejected(readAssetUpload(file))
    expect(failure.code).toBe('ASSET_STORAGE_FAILED')
    expect(failure.message).toMatch(/PNG, JPEG, or WebP/)
  })
})

describe('asset file conversion', () => {
  /** Replace the global fetch with one answering the given response. */
  function stubFetch(response: Response): ReturnType<typeof vi.fn> {
    const fetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('builds an uploadable file from the stored bytes', async () => {
    const fetch = stubFetch(new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }))
    const file = await assetFileFromUrl(ASSET.url, 'Hero')
    expect(fetch).toHaveBeenCalledWith(ASSET.url)
    expect(file.name).toBe('Hero.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(3)
  })

  it('names a JPEG file with its own extension', async () => {
    stubFetch(new Response(Uint8Array.of(1, 2), { headers: { 'content-type': 'image/jpeg' } }))
    const file = await assetFileFromUrl(ASSET.url, 'Scene 2')
    expect(file.name).toBe('Scene 2.jpg')
    expect(file.type).toBe('image/jpeg')
  })

  it('replaces characters a file name cannot carry', async () => {
    stubFetch(new Response(Uint8Array.of(1), { headers: { 'content-type': 'image/png' } }))
    await expect(assetFileFromUrl(ASSET.url, '  Hero/02  ')).resolves.toMatchObject({ name: 'Hero 02.png' })
  })

  it('reports an unsuccessful response', async () => {
    stubFetch(new Response('not found', { status: 404 }))
    const failure = await rejected(assetFileFromUrl(ASSET.url, 'Hero'))
    expect(failure.code).toBe('ASSET_STORAGE_FAILED')
    expect(failure.message).toMatch(/404/)
  })

  it('reports bytes that are not a supported image', async () => {
    stubFetch(new Response(Uint8Array.of(1), { headers: { 'content-type': 'application/octet-stream' } }))
    const failure = await rejected(assetFileFromUrl(ASSET.url, 'Hero'))
    expect(failure.code).toBe('ASSET_STORAGE_FAILED')
    expect(failure.message).toMatch(/PNG, JPEG, or WebP/)
  })

  it('reports a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const failure = await rejected(assetFileFromUrl(ASSET.url, 'Hero'))
    expect(failure.code).toBe('ASSET_STORAGE_FAILED')
  })
})
