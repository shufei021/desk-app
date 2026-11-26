// @vitest-environment jsdom
/** Asset panel over the workspace library: selection, listing, reference reuse, addition and deletion. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageReference, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import type { WorkspaceAsset, WorkspaceSummary } from '../src/client/assets.ts'
import { createFakeAssetLibrary, type FakeAssetLibraryOptions } from './asset-library-stub.client.ts'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const imageId = 'image-service' as ServiceId
const image: ServiceView = {
  id: imageId, capability: 'image', name: 'Image studio', configured: true,
  model: 'image-model', baseURL: 'https://api.example.test/v1',
}
const STORY: WorkspaceSummary = { id: 'workspace-1', title: 'Story', path: 'C:/work/story' }
const ARCADE: WorkspaceSummary = { id: 'workspace-2', title: 'Arcade', path: 'C:/work/arcade' }
const WORKSPACE_KEY = 'dsh.directAi.assetWorkspace'
/**
 * Build one stored asset.
 * @param overrides - fields the test needs to change.
 * @returns the asset as the Host would report it.
 */
function asset(overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    name: 'Hero.png', title: 'Hero', category: 'character', bytes: 3,
    modifiedAt: Date.UTC(2026, 10, 20, 8),
    url: 'api/workspace-assets/file?id=Hero.png&workspace=workspace-1&category=character',
    ...overrides,
  }
}
/**
 * Build one durable reference for the upload stub.
 * @param name - file name the upload path received.
 * @returns the reference the controller would return.
 */
function reference(name: string): ImageReference {
  return {
    attachmentId: `${name}-attachment` as ImageReference['attachmentId'],
    mediaType: 'image/png', bytes: 3, width: 1, height: 1, name,
  }
}

const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`)
const revokeObjectUrl = vi.fn<(url: string) => void>()
let previousCreate: PropertyDescriptor | undefined
let previousRevoke: PropertyDescriptor | undefined

beforeEach(() => {
  window.localStorage.clear()
  createObjectUrl.mockClear()
  revokeObjectUrl.mockClear()
  previousCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  previousRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
})

afterEach(() => {
  cleanup()
  if (previousCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
  else Object.defineProperty(URL, 'createObjectURL', previousCreate)
  if (previousRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
  else Object.defineProperty(URL, 'revokeObjectURL', previousRevoke)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mount the image workspace over the given workspace library and return its assets. */
function mount(options: FakeAssetLibraryOptions = {}) {
  const catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle' }
  const interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle' }
  const history: HistoryState = { phase: 'ready', records: [] }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const assetLibrary = createFakeAssetLibrary(options)
  const uploadReference = vi.fn<ImageStudioProps['uploadReference']>(async (file: File) => reference(file.name))
  const actions = {
    refresh: vi.fn<ImageStudioProps['refresh']>(async () => {}),
    save: vi.fn<ImageStudioProps['save']>(async () => true),
    remove: vi.fn<ImageStudioProps['remove']>(async () => true),
    select: vi.fn<ImageStudioProps['select']>(),
    submit: vi.fn<ImageStudioProps['submit']>(async () => false),
    uploadReference,
    stop: vi.fn(), clear: vi.fn(), restore: vi.fn(), backToAgent: vi.fn(),
    discoverModels: vi.fn<ImageStudioProps['discoverModels']>(async () => true), clearDirectory: vi.fn(),
    assetLibrary,
    assistChat: vi.fn<ImageStudioProps['assistChat']>(async () => ({ status: 'completed' })),
    variantRun: vi.fn<ImageStudioProps['variantRun']>(() => ({
      dispose: () => {},
      async *[Symbol.asyncIterator]() { yield { type: 'done' } },
    })),
  }
  const props: ImageStudioProps = {
    ...({} as GlobalStandardProps), ...actions,
    useCatalog: select => select(catalog), useInteraction: select => select(interaction),
    useHistory: select => select(history), useDirectory: select => select(directory),
    t: makeTranslate(en),
  }
  render(<ImageStudio {...props} />)
  return {
    assetLibrary, uploadReference,
    /** The single-file picker the asset form owns, inside the portalled dialog. */
    assetPicker(): HTMLInputElement {
      const input = [...document.body.querySelectorAll<HTMLInputElement>('input[type="file"]')]
        .find(candidate => !candidate.multiple)
      if (input === undefined) throw new Error('asset file picker is missing')
      return input
    },
    /** The workspace selector button, named by its label and the selected workspace. */
    workspaceButton(): HTMLElement {
      return screen.getByRole('button', { name: new RegExp(`^${en.assetWorkspace} `) })
    },
  }
}

/** Open the asset library from the workspace toolbar and wait for the first read to settle. */
async function openLibrary(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: en.assets }))
  return screen.findByRole('dialog', { name: en.assets })
}

describe('image studio asset library', () => {
  it('lists the selected category of the first workspace with its counts, title and modification time', async () => {
    mount({ assets: { 'workspace-1': [asset(), asset({ name: 'Hall.png', title: 'Hall', category: 'scene' })] } })
    await openLibrary()
    await waitFor(() => { expect(screen.getByText('Hero')).toBeTruthy() })
    expect(screen.getByRole('tab', { name: `${en.assetCategoryCharacter} (1)` })).toBeTruthy()
    expect(screen.getByRole('tab', { name: `${en.assetCategoryScene} (1)` })).toBeTruthy()
    expect(screen.getByRole('tab', { name: `${en.assetCategoryProp} (0)` })).toBeTruthy()
    expect(screen.queryByText('Hall')).toBeNull()
    // The thumbnail is served by the Host byte route the listing reports.
    const thumbnail = screen.getByRole<HTMLImageElement>('img', { name: 'Hero' })
    expect(thumbnail.getAttribute('src')).toBe(asset().url)
    expect(screen.getByText(new Date(asset().modifiedAt).toLocaleString())).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: `${en.assetCategoryScene} (1)` }))
    expect(screen.getByText('Hall')).toBeTruthy()
    expect(screen.queryByText('Hero')).toBeNull()
  })

  it('opens the remembered workspace and re-lists when another workspace is chosen', async () => {
    window.localStorage.setItem(WORKSPACE_KEY, ARCADE.id)
    const view = mount({
      workspaces: [STORY, ARCADE],
      assets: {
        'workspace-1': [asset()],
        'workspace-2': [asset({
          name: 'Coin.png', title: 'Coin',
          url: 'api/workspace-assets/file?id=Coin.png&workspace=workspace-2&category=character',
        })],
      },
    })
    await openLibrary()
    await waitFor(() => { expect(screen.getByText('Coin')).toBeTruthy() })
    expect(view.workspaceButton().textContent).toContain(ARCADE.title)
    expect(screen.queryByText('Hero')).toBeNull()

    fireEvent.click(view.workspaceButton())
    fireEvent.click(screen.getByRole('menuitem', { name: STORY.title }))
    await waitFor(() => { expect(screen.getByText('Hero')).toBeTruthy() })
    expect(screen.queryByText('Coin')).toBeNull()
    expect(window.localStorage.getItem(WORKSPACE_KEY)).toBe(STORY.id)
  })

  it('explains that a workspace must exist before assets can be stored', async () => {
    mount({ workspaces: [] })
    await openLibrary()
    expect(await screen.findByText(en.assetWorkspaceEmpty)).toBeTruthy()
    expect(screen.queryByText(en.assetAdd)).toBeNull()
    expect(screen.queryByRole('tab', { name: new RegExp(en.assetCategoryCharacter) })).toBeNull()
  })

  it('attaches a stored asset through the reference upload path', async () => {
    const view = mount({ assets: { 'workspace-1': [asset()] } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(1, 2, 3), {
      headers: { 'content-type': 'image/png' },
    })))
    await openLibrary()
    await waitFor(() => { expect(screen.getByText('Hero')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: `${en.assetUseAsReference} Hero` }))
    await waitFor(() => { expect(view.uploadReference).toHaveBeenCalledOnce() })
    const uploaded = view.uploadReference.mock.calls[0]?.[0]
    expect(uploaded).toBeInstanceOf(File)
    expect(uploaded?.name).toBe('Hero.png')
    expect(uploaded?.type).toBe('image/png')
    await waitFor(() => {
      const thumbnail = screen.getByRole('img', { name: en.references })
      expect(thumbnail.getAttribute('src')).toBe('blob:Hero.png')
    })
    // The panel closes so the attached reference is visible in the composer.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('deletes an asset only after a second confirming click', async () => {
    const view = mount({ assets: { 'workspace-1': [asset()] } })
    await openLibrary()
    await waitFor(() => { expect(screen.getByText('Hero')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: `${en.assetDelete} Hero` }))
    expect(screen.getByText(en.assetDeleteConfirm)).toBeTruthy()
    expect(view.assetLibrary.removed).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: `${en.assetDeleteConfirm} Hero` }))
    await waitFor(() => { expect(screen.queryByText('Hero')).toBeNull() })
    expect(view.assetLibrary.removed).toEqual([{
      workspaceId: STORY.id, category: 'character', name: asset().name,
    }])
    expect(await view.assetLibrary.list(STORY.id)).toEqual([])
  })

  it('stores a selected image with its name and category, then lists it', async () => {
    const view = mount()
    await openLibrary()
    await waitFor(() => { expect(screen.getByText(en.assetsEmpty)).toBeTruthy() })

    fireEvent.change(view.assetPicker(), {
      target: { files: [new File([Uint8Array.of(1, 2, 3)], 'sword.png', { type: 'image/png' })] },
    })
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: en.assetName })
    expect(name.value).toBe('sword')
    fireEvent.change(name, { target: { value: 'Sword' } })
    fireEvent.click(screen.getByRole('button', { name: en.assetCategory }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.assetCategoryProp }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => { expect(screen.getByText('Sword')).toBeTruthy() })
    expect(screen.getByText(en.assetCreated)).toBeTruthy()
    expect(screen.getByRole('tab', { name: `${en.assetCategoryProp} (1)` })).toBeTruthy()
    expect(view.assetLibrary.saved).toEqual([{
      workspaceId: STORY.id, category: 'prop', title: 'Sword', data: 'AQID', mime: 'image/png',
    }])
    // The form is cleared so the same file cannot be added twice by accident.
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.assetName }).value).toBe('')
  })

  it('reports a failed read and reads again on retry', async () => {
    const view = mount({ assets: { 'workspace-1': [asset()] } })
    const list = vi.spyOn(view.assetLibrary, 'list').mockRejectedValueOnce(new Error('Host unavailable'))
    await openLibrary()
    expect(await screen.findByText(en.assetStorageFailed)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByText('Hero')).toBeTruthy() })
    expect(list).toHaveBeenCalledTimes(2)
  })
})
