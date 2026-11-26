// @vitest-environment jsdom
/** Image workspace bottom tool row: reference intake, generation mode, assets, parameters and submission. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectFrame, ImageReference, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import { IMAGE_PARAMS_KEY, type ImageQuality } from '../src/client/image-params.ts'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const imageId = 'image-service' as ServiceId
const image: ServiceView = {
  id: imageId, capability: 'image', name: 'Image studio', configured: true,
  model: 'image-model', baseURL: 'https://api.example.test/v1',
}
const startedAt = Date.UTC(2026, 10, 20, 8)
const media: readonly DirectFrame[] = [
  { type: 'media', url: 'api/direct-ai/media?id=toolbar', mime: 'image/png' }, { type: 'done' },
]

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
  vi.restoreAllMocks()
})

/**
 * Mount the studio over a driven controller: a submitted run fills the interaction the way the real
 * controller does, including the generation parameters the request carried.
 */
function mount() {
  const catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle' }
  let interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle' }
  const history: HistoryState = { phase: 'ready', records: [] }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  let repaint = (): void => {}
  const actions = {
    refresh: vi.fn<ImageStudioProps['refresh']>(async () => {}),
    save: vi.fn<ImageStudioProps['save']>(async () => true),
    remove: vi.fn<ImageStudioProps['remove']>(async () => true),
    select: vi.fn<ImageStudioProps['select']>(),
    submit: vi.fn<ImageStudioProps['submit']>(async (prompt, _system, parameters, references, _mask, displayPrompt) => {
      const carried = parameters === ''
        ? undefined
        : JSON.parse(parameters) as { size: string; quality: ImageQuality; n: number }
      interaction = {
        serviceId: imageId, messages: [{ role: 'user', content: prompt }], frames: [...media], phase: 'completed',
        run: {
          ...displayPrompt === undefined ? {} : { displayPrompt },
          serviceName: image.name, model: image.model, startedAt, referenceCount: references?.length ?? 0,
          ...carried === undefined
            ? {}
            : { imageParams: { size: carried.size, quality: carried.quality, count: carried.n } },
        },
      }
      repaint()
      return true
    }),
    uploadReference: vi.fn<ImageStudioProps['uploadReference']>(async (file: File) => reference(file.name)),
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
  repaint = () => { view.rerender(<ImageStudio {...props} />) }
  return {
    ...view, ...actions,
    picker(): HTMLInputElement {
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
      if (input === null) throw new Error('reference file picker is missing')
      return input
    },
  }
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt })
}

/** The generation-mode trigger; its accessible name starts with the mode label text. */
function modeButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: new RegExp(`^${en.generationMode}`) })
}

function parametersButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: en.imageParams })
}

function addButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: en.addReference })
}

function chooseMode(name: string): void {
  fireEvent.click(modeButton())
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

function parameterDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: en.imageParamsTitle })
}

/** Choose one pill inside the parameter dialog by its visible label. */
function pill(name: string): void {
  fireEvent.click(within(parameterDialog()).getByRole('button', { name }))
}

function closeParameters(): void {
  // The dialog header and its footer both close; either one reports the same command.
  fireEvent.click(within(parameterDialog()).getAllByRole('button', { name: en.close })[0] as HTMLElement)
}

/** Choose the aspect ratio, resolution, quality and count the submission should carry. */
function chooseWideParameters(): void {
  fireEvent.click(parametersButton())
  pill('16:9')
  pill('2K')
  pill(en.qualityHigh)
  pill('2')
  closeParameters()
}

describe('image studio tool row', () => {
  it('renders thumbnails, the description and one tool row with the counter and the send control', () => {
    const view = mount()
    expect(addButton().disabled).toBe(false)
    expect(modeButton().textContent).toContain(en.presetNone)
    expect(screen.getByRole('button', { name: en.assets })).toBeTruthy()
    expect(parametersButton().disabled).toBe(false)
    expect(screen.getByRole('button', { name: `${en.imageStudioSelectService}: ${image.name}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.generate })).toBeTruthy()
    expect(screen.getByText('0/4000')).toBeTruthy()
    expect(promptBox().maxLength).toBe(4000)

    fireEvent.change(promptBox(), { target: { value: 'A red fox' } })
    expect(screen.getByText('9/4000')).toBeTruthy()

    // Reference intake still accepts several images through the same picker the + control opens.
    expect(view.picker().multiple).toBe(true)
    expect(view.picker().accept).toBe('image/png,image/jpeg,image/webp')
  })

  it('opens the reference file picker from the + control', () => {
    mount()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    fireEvent.click(addButton())
    expect(click).toHaveBeenCalledOnce()
  })

  it('switches generation modes and shows the mask control only in mask editing', () => {
    mount()
    expect(screen.queryByRole('button', { name: en.editMask })).toBeNull()

    chooseMode(en.presetMaskEdit)
    expect(modeButton().textContent).toContain(en.presetMaskEdit)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.editMask }).disabled).toBe(true)
    expect(screen.getByText(en.maskNeedsOneReference)).toBeTruthy()

    chooseMode(en.presetCharacterTurnaround)
    expect(screen.queryByRole('button', { name: en.editMask })).toBeNull()
    expect(screen.getByText(en.presetTemplateHint)).toBeTruthy()
    expect(screen.getByText(en.presetNeedsOneReference)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }).disabled).toBe(true)
  })

  it('opens the asset library from the tool row', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: en.assets }))
    expect(await screen.findByRole('dialog', { name: en.assets })).toBeTruthy()
  })

  it('opens, closes and backfills the parameter dialog with its converged size', () => {
    mount()
    fireEvent.click(parametersButton())
    expect(parameterDialog()).toBeTruthy()

    pill('16:9')
    pill('2K')
    pill(en.qualityHigh)
    pill('2')
    expect(within(parameterDialog()).getByRole<HTMLInputElement>('spinbutton', { name: en.sizeWidth }).value).toBe('2048')
    expect(within(parameterDialog()).getByRole<HTMLInputElement>('spinbutton', { name: en.sizeHeight }).value).toBe('1152')

    // Typing an out-of-range edge is corrected in place: 5000 becomes 3840 and keeps the 16:9 ratio.
    const width = within(parameterDialog()).getByRole<HTMLInputElement>('spinbutton', { name: en.sizeWidth })
    fireEvent.change(width, { target: { value: '5000' } })
    expect(within(parameterDialog()).getByRole<HTMLInputElement>('spinbutton', { name: en.sizeHeight }).value).toBe('2160')
    fireEvent.blur(width)
    expect(width.value).toBe('3840')
    expect(JSON.parse(window.localStorage.getItem(IMAGE_PARAMS_KEY) ?? '{}'))
      .toMatchObject({ width: 3840, height: 2160, quality: 'high', count: 2 })

    closeParameters()
    expect(screen.queryByRole('dialog', { name: en.imageParamsTitle })).toBeNull()

    // Reopening shows the stored selection rather than the defaults.
    fireEvent.click(parametersButton())
    expect(within(parameterDialog()).getByRole('button', { name: '16:9' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(parameterDialog()).getByRole('button', { name: '2K' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(parameterDialog()).getByRole('button', { name: en.qualityHigh }).getAttribute('aria-pressed')).toBe('true')
    expect(within(parameterDialog()).getByRole('button', { name: '2' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(parameterDialog()).getByRole<HTMLInputElement>('spinbutton', { name: en.sizeWidth }).value).toBe('3840')
    expect(within(parameterDialog()).getByRole<HTMLInputElement>('spinbutton', { name: en.sizeHeight }).value).toBe('2160')
  })

  it('submits the chosen parameters and shows size, quality and count on the result card', async () => {
    const view = mount()
    chooseWideParameters()
    fireEvent.change(promptBox(), { target: { value: 'A wide product photo' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))

    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    expect(view.submit.mock.calls[0]?.[2]).toBe('{"size":"2048x1152","quality":"high","n":2}')
    expect(view.submit.mock.calls[0]?.[0]).toBe('A wide product photo')

    await waitFor(() => { expect(screen.getByRole('region', { name: en.promptLabel })).toBeTruthy() })
    const card = screen.getByRole('region', { name: en.promptLabel })
    expect(card.textContent).toContain(en.resultSize.replace('{size}', '2048x1152'))
    expect(card.textContent).toContain(en.resultQuality.replace('{quality}', en.qualityHigh))
    expect(card.textContent).toContain(en.resultCount.replace('{count}', '2'))
  })

  it('sends no parameters until the dialog was opened', async () => {
    const view = mount()
    fireEvent.change(promptBox(), { target: { value: 'Provider defaults' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))
    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    expect(view.submit.mock.calls[0]?.[2]).toBe('')
  })
})
