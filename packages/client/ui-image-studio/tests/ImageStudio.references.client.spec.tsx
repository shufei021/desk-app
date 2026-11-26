// @vitest-environment jsdom
/** Reference-image intake in the image workspace: local previews, limits, failures and submission. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageReference, RunId, RunRecord, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
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
    update(values: { catalog?: Partial<CatalogState> }): void {
      catalog = { ...catalog, ...values.catalog }
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

describe('image studio references', () => {
  it('uploads each selected file and shows a local preview', async () => {
    const view = mount()
    expect(view.picker().multiple).toBe(true)
    expect(view.picker().accept).toBe('image/png,image/jpeg,image/webp')
    const file = select('sea.png')
    addFiles(view.picker(), [file])
    await waitFor(() => { expect(view.uploadReference).toHaveBeenCalledExactlyOnceWith(file) })
    await waitFor(() => {
      expect(screen.getByRole('img', { name: en.references }).getAttribute('src')).toBe('blob:sea.png')
    })
    expect(createObjectUrl).toHaveBeenCalledWith(file)
    expect(screen.getByText(en.referenceEditHint)).toBeTruthy()
  })

  it('removes one reference and revokes its preview URL', async () => {
    const view = mount()
    addFiles(view.picker(), [select('first.png'), select('second.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: `${en.removeReference} 1` }))
    expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first.png')
    expect(revokeObjectUrl).not.toHaveBeenCalledWith('blob:second.png')
  })

  it('stops at eight references and explains the limit', async () => {
    const view = mount()
    const files = Array.from({ length: 9 }, (_, index) => select(`ref-${index}.png`))
    addFiles(view.picker(), files)
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(8) })
    expect(view.uploadReference).toHaveBeenCalledTimes(8)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addReference }).disabled).toBe(true)
    expect(screen.getByText(en.referenceLimit.replace('{max}', '8'))).toBeTruthy()
  })

  it('disables adding while an upload is pending', async () => {
    const pending = Promise.withResolvers<ImageReference | undefined>()
    const uploadReference = vi.fn<ImageStudioProps['uploadReference']>(() => pending.promise)
    const view = mount({ uploadReference })
    addFiles(view.picker(), [select('slow.png')])
    await waitFor(() => { expect(uploadReference).toHaveBeenCalledOnce() })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: en.addReference })
    expect(button.disabled).toBe(true)
    pending.resolve(reference('slow.png'))
    await waitFor(() => { expect(button.disabled).toBe(false) })
  })

  it('drops the preview and reports a failed upload', async () => {
    const uploadReference = vi.fn<ImageStudioProps['uploadReference']>(async () => undefined)
    const view = mount({ uploadReference })
    addFiles(view.picker(), [select('broken.png')])
    await waitFor(() => { expect(uploadReference).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('img', { name: en.references })).toBeNull()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:broken.png')
    view.update({ catalog: { error: 'referenceUploadFailed' } })
    expect(screen.getByRole('alert').textContent).toBe(en.referenceUploadFailed)
  })

  it('submits the uploaded references and clears them after a confirmed completion', async () => {
    const view = mount()
    addFiles(view.picker(), [select('first.png'), select('second.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(2) })
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt }), {
      target: { value: 'A red fox' },
    })
    view.submit.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))
    await waitFor(() => {
      expect(view.submit).toHaveBeenCalledExactlyOnceWith('A red fox', '', '', [reference('first.png'), reference('second.png')],
        undefined, 'A red fox')
    })
    await waitFor(() => { expect(screen.queryAllByRole('img', { name: en.references })).toHaveLength(0) })
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first.png')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second.png')
  })

  it('keeps the references after an unconfirmed submission', async () => {
    const view = mount()
    addFiles(view.picker(), [select('kept.png')])
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1) })
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt }), {
      target: { value: 'Keep it' },
    })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))
    await waitFor(() => { expect(view.submit).toHaveBeenCalledOnce() })
    expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1)
    expect(revokeObjectUrl).not.toHaveBeenCalled()
  })

  it('labels a retained generation with its reference-image count', () => {
    const record: RunRecord = {
      id: 'run-with-references' as RunId, service: image, startedAt: Date.UTC(2026, 10, 20, 8), status: 'completed',
      request: {
        serviceId: imageId,
        messages: [{ role: 'user', content: 'A lake' }],
        references: [reference('one.png'), reference('two.png')],
      },
      frames: [{ type: 'media', url: 'api/direct-ai/media?id=references', mime: 'image/png' }, { type: 'done' }],
    }
    mount({ history: { records: [record] } })
    fireEvent.click(screen.getByText(en.imageStudioRecent))
    expect(screen.getByText('2 reference images')).toBeTruthy()
  })
})
