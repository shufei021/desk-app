// @vitest-environment jsdom
/** Preset selection in the image workspace: one-reference rule and composed submission. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageReference, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import { PROMPT_TEMPLATES } from '../src/client/prompt-presets.ts'
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
  const catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle', ...options.catalog }
  const interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle', ...options.interaction }
  const history: HistoryState = { phase: 'ready', records: [], ...options.history }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const uploadReference = options.uploadReference
    ?? vi.fn<ImageStudioProps['uploadReference']>(async (file: File) => reference(file.name))
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
  return {
    ...view, ...actions,
    picker(): HTMLInputElement {
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
      if (input === null) throw new Error('reference file picker is missing')
      return input
    },
  }
}

function addFiles(picker: HTMLInputElement, files: readonly File[]): void {
  fireEvent.change(picker, { target: { files } })
}

/** Choose one preset through the generation-mode menu; the trigger names the current mode. */
function choosePreset(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.generationMode}`) }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

function select(fileName: string): File {
  return new File([Uint8Array.of(1, 2, 3, 4)], fileName, { type: 'image/png' })
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt })
}

const generateButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: en.generate })

describe('image studio prompt presets', () => {
  it('blocks a template preset unless exactly one reference image is attached', async () => {
    const view = mount()
    choosePreset(en.presetCharacterTurnaround)
    expect(screen.getByText(en.presetTemplateHint)).toBeTruthy()
    expect(screen.getByText(en.presetNeedsOneReference)).toBeTruthy()
    expect(generateButton().disabled).toBe(true)

    addFiles(view.picker(), [select('first.png'), select('second.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(2) })
    expect(screen.getByText(en.presetNeedsOneReference)).toBeTruthy()
    expect(generateButton().disabled).toBe(true)
  })

  it('submits description plus template and keeps the composer free of the template', async () => {
    const view = mount()
    const description = '同一个角色，红色外套'
    fireEvent.change(promptBox(), { target: { value: description } })
    addFiles(view.picker(), [select('character.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1) })

    choosePreset(en.presetCharacterTurnaround)
    // Switching the preset keeps both the typed description and the attached reference.
    expect(promptBox().value).toBe(description)
    expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1)
    expect(generateButton().disabled).toBe(false)

    fireEvent.click(generateButton())
    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    const submitted = view.submit.mock.calls[0]?.[0]
    expect(submitted).toBe(`${description}\n\n${PROMPT_TEMPLATES.characterTurnaround}`)
    expect(submitted).toContain('正交')
    expect(view.submit.mock.calls[0]?.[3]).toEqual([reference('character.png')])
    expect(promptBox().value).toBe(description)
    expect(promptBox().value).not.toContain('正交')
  })

  it('submits the scene template alone when the description is empty', async () => {
    const view = mount()
    addFiles(view.picker(), [select('room.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1) })
    choosePreset(en.presetSceneMultiView)
    expect(generateButton().disabled).toBe(false)

    fireEvent.click(generateButton())
    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    expect(view.submit.mock.calls[0]?.[0]).toBe(PROMPT_TEMPLATES.sceneMultiView)
    expect(view.submit.mock.calls[0]?.[0]).toContain('2×2')
  })

  it('returns to submitting the raw description after switching back to the free preset', async () => {
    const view = mount()
    const description = '一只雪地里的红狐狸'
    fireEvent.change(promptBox(), { target: { value: description } })
    addFiles(view.picker(), [select('fox.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1) })

    choosePreset(en.presetSceneMultiView)
    choosePreset(en.presetNone)
    expect(screen.queryByText(en.presetTemplateHint)).toBeNull()
    expect(screen.queryByText(en.presetNeedsOneReference)).toBeNull()
    expect(promptBox().value).toBe(description)

    fireEvent.click(generateButton())
    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    expect(view.submit.mock.calls[0]?.[0]).toBe(description)
  })
})
