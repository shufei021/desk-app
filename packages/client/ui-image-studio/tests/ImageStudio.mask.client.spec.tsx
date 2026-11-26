// @vitest-environment jsdom
/** Mask editing in the image workspace: one-reference rule, dialog, stored mask and submission. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageReference, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const imageId = 'image-service' as ServiceId
const image: ServiceView = {
  id: imageId, capability: 'image', name: 'Image studio', configured: true,
  model: 'image-model', baseURL: 'https://api.example.test/v1',
}

function reference(name: string): ImageReference {
  return {
    attachmentId: `${name}-attachment` as ImageReference['attachmentId'],
    mediaType: 'image/png', bytes: 4, width: 1, height: 1, name,
  }
}

const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`)
const revokeObjectUrl = vi.fn<(url: string) => void>()
let previousCreate: PropertyDescriptor | undefined
let previousRevoke: PropertyDescriptor | undefined

beforeEach(() => {
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
  vi.restoreAllMocks()
})

function mount(options: {
  catalog?: Partial<CatalogState>
  interaction?: Partial<InteractionState>
  history?: Partial<HistoryState>
  uploadReference?: ImageStudioProps['uploadReference']
} = {}) {
  let catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle', ...options.catalog }
  const interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle', ...options.interaction }
  const history: HistoryState = { phase: 'ready', records: [], ...options.history }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const uploadReference = vi.fn<ImageStudioProps['uploadReference']>(
    options.uploadReference ?? (async (file: File) => reference(file.name)),
  )
  const actions = {
    refresh: vi.fn<ImageStudioProps['refresh']>(async () => {}),
    save: vi.fn<ImageStudioProps['save']>(async () => true),
    remove: vi.fn<ImageStudioProps['remove']>(async () => true),
    select: vi.fn<ImageStudioProps['select']>(),
    submit: vi.fn<ImageStudioProps['submit']>(async () => false),
    uploadReference,
    stop: vi.fn(), clear: vi.fn(), restore: vi.fn(), backToAgent: vi.fn(),
    discoverModels: vi.fn<ImageStudioProps['discoverModels']>(async () => true), clearDirectory: vi.fn(),
    assetLibrary: createFakeAssetLibrary(),
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
  const view = render(<ImageStudio {...props} />)
  // Every case here exercises mask editing, where the editor button lives; enter it from the mode menu.
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.generationMode}`) }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.presetMaskEdit }))
  return {
    ...view, ...actions,
    picker(): HTMLInputElement {
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
      if (input === null) throw new Error('reference file picker is missing')
      return input
    },
    updateCatalog(values: Partial<CatalogState>): void {
      catalog = { ...catalog, ...values }
      view.rerender(<ImageStudio {...props} />)
    },
  }
}

function addFiles(picker: HTMLInputElement, files: readonly File[]): void {
  fireEvent.change(picker, { target: { files } })
}

function select(fileName: string): File {
  return new File([Uint8Array.of(1, 2, 3, 4)], fileName, { type: 'image/png' })
}

/**
 * Build the pixels the mask canvas reports: black RGB with the supplied alpha per pixel.
 * @param alphas - alpha value of each pixel.
 * @returns synthetic ImageData read back by the dialog.
 */
function maskPixels(alphas: readonly number[]): ImageData {
  const data = new Uint8ClampedArray(alphas.length * 4)
  for (const [index, alpha] of alphas.entries()) data[index * 4 + 3] = alpha
  return { colorSpace: 'srgb', data, width: alphas.length, height: 1 }
}

/** Serve the canvas API the dialog needs from jsdom, reporting the given mask pixels. */
function stubCanvas(pixels: ImageData): Partial<CanvasRenderingContext2D> {
  const context: Partial<CanvasRenderingContext2D> = {
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '#000',
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: () => pixels,
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=')
  return context
}

/** Load the reference image shown in the mask dialog; jsdom reports no natural size. */
function loadSourceImage(size = 4): void {
  const source = screen.getByRole<HTMLImageElement>('img', { name: en.maskSourcePreview })
  Object.defineProperty(source, 'naturalWidth', { configurable: true, value: size })
  Object.defineProperty(source, 'naturalHeight', { configurable: true, value: size })
  fireEvent.load(source)
}

const maskButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: en.editMask })
const applyButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: en.maskApply })
const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: en.maskTitle })

/** Attach one reference image through the picker and wait for its thumbnail. */
async function attachOne(view: ReturnType<typeof mount>, fileName: string): Promise<void> {
  addFiles(view.picker(), [select(fileName)])
  await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1) })
}

/** Open the dialog for the attached reference and finish its canvas preparation. */
function openEditor(): void {
  fireEvent.click(maskButton())
  loadSourceImage()
}

describe('image studio mask editing', () => {
  it('enables the editor only for exactly one reference image and explains the rule', async () => {
    const view = mount()
    expect(screen.getByText(en.maskNeedsOneReference)).toBeTruthy()
    expect(maskButton().disabled).toBe(true)

    addFiles(view.picker(), [select('first.png'), select('second.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(2) })
    expect(screen.getByText(en.maskNeedsOneReference)).toBeTruthy()
    expect(maskButton().disabled).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('opens the dialog for one reference and stores the erased mask as a reference', async () => {
    stubCanvas(maskPixels([255, 255, 0, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')

    expect(maskButton().disabled).toBe(false)
    expect(screen.queryByText(en.maskNeedsOneReference)).toBeNull()
    openEditor()
    expect(dialog()).not.toBeNull()

    fireEvent.click(applyButton())
    await waitFor(() => { expect(view.uploadReference).toHaveBeenCalledTimes(2) })
    const maskFile = view.uploadReference.mock.calls[1]?.[0]
    expect(maskFile).toBeInstanceOf(File)
    expect(maskFile?.name).toBe('sea-mask.png')
    expect(maskFile?.type).toBe('image/png')

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(screen.getByText(en.maskReady)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.maskReedit })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.maskClear })).toBeTruthy()
  })

  it('refuses an opaque mask, keeps the dialog open and uploads nothing', async () => {
    stubCanvas(maskPixels([255, 255, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')
    openEditor()

    fireEvent.click(applyButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.maskEmpty) })
    expect(view.uploadReference).toHaveBeenCalledExactlyOnceWith(expect.any(File))
    expect(dialog()).not.toBeNull()
    expect(screen.queryByText(en.maskReady)).toBeNull()
  })

  it('submits the stored mask as the fifth argument', async () => {
    stubCanvas(maskPixels([255, 0, 255, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')
    openEditor()
    fireEvent.click(applyButton())
    await waitFor(() => { expect(screen.getByText(en.maskReady)).toBeTruthy() })

    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt }), {
      target: { value: 'Clear the sky' },
    })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))
    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    expect(view.submit.mock.calls[0]?.[3]).toEqual([reference('sea.png')])
    expect(view.submit.mock.calls[0]?.[4]).toEqual(reference('sea-mask.png'))
  })

  it('drops the stored mask when another reference image joins', async () => {
    stubCanvas(maskPixels([255, 0, 255, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')
    openEditor()
    fireEvent.click(applyButton())
    await waitFor(() => { expect(screen.getByText(en.maskReady)).toBeTruthy() })

    addFiles(view.picker(), [select('second.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(2) })
    expect(screen.queryByText(en.maskReady)).toBeNull()
    expect(screen.queryByRole('button', { name: en.maskClear })).toBeNull()
    expect(screen.getByText(en.maskNeedsOneReference)).toBeTruthy()
  })

  it('clears a stored mask from its control', async () => {
    stubCanvas(maskPixels([255, 0, 255, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')
    openEditor()
    fireEvent.click(applyButton())
    await waitFor(() => { expect(screen.getByText(en.maskReady)).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: en.maskClear }))
    expect(screen.queryByText(en.maskReady)).toBeNull()
    expect(screen.getByRole('button', { name: en.editMask })).toBeTruthy()
  })

  it('reports a canvas the browser cannot give a 2D context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const view = mount()
    await attachOne(view, 'sea.png')
    fireEvent.click(maskButton())
    loadSourceImage()
    expect(screen.getByRole('alert').textContent).toBe(en.maskEditorFailed)
    expect(applyButton().disabled).toBe(true)
  })

  it('reports a reference image with no readable pixels', async () => {
    stubCanvas(maskPixels([255, 0]))
    const view = mount()
    await attachOne(view, 'sea.png')
    fireEvent.click(maskButton())
    loadSourceImage(0)
    expect(screen.getByRole('alert').textContent).toBe(en.maskEditorFailed)
    expect(applyButton().disabled).toBe(true)
    expect(view.uploadReference).toHaveBeenCalledExactlyOnceWith(expect.any(File))
  })

  it('restores the opaque mask on reset', async () => {
    const context = stubCanvas(maskPixels([255, 0, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')
    openEditor()

    fireEvent.click(screen.getByRole('button', { name: en.maskReset }))
    // The first fill prepared the canvas; the reset paints it again as one opaque surface.
    expect(context.fillRect).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the dialog open when the produced mask cannot be stored', async () => {
    stubCanvas(maskPixels([255, 0, 255]))
    const uploadReference = vi.fn<ImageStudioProps['uploadReference']>(
      async (file: File) => file.name === 'sea.png' ? reference('sea.png') : undefined,
    )
    const view = mount({ uploadReference })
    await attachOne(view, 'sea.png')
    openEditor()

    fireEvent.click(applyButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.referenceUploadFailed) })
    expect(dialog()).not.toBeNull()
    expect(screen.queryByText(en.maskReady)).toBeNull()
    expect(view.uploadReference).toHaveBeenCalledTimes(2)
  })

  it('reopens the kept mask for another edit', async () => {
    stubCanvas(maskPixels([255, 0, 255]))
    const view = mount()
    await attachOne(view, 'sea.png')
    openEditor()
    fireEvent.click(applyButton())
    await waitFor(() => { expect(screen.getByText(en.maskReady)).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: en.maskReedit }))
    loadSourceImage()
    const kept = document.querySelector<HTMLImageElement>('img[src="data:image/png;base64,iVBORw0KGgo="]')
    if (kept === null) throw new Error('the kept mask PNG is not restored')
    fireEvent.load(kept)
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(applyButton())
    await waitFor(() => { expect(view.uploadReference).toHaveBeenCalledTimes(3) })
    expect(screen.getByText(en.maskReady)).toBeTruthy()
  })
})
