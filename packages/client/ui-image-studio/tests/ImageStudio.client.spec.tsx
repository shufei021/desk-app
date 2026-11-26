// @vitest-environment jsdom
/** Image studio behavior with controller-owned snapshots; no chat model or Agent input is supplied. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { Capability, RunId, RunRecord, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

const chatId = 'chat-service' as ServiceId
const imageId = 'image-service' as ServiceId
const videoId = 'video-service' as ServiceId

function service(id: ServiceId, capability: Capability, name: string, configured = true): ServiceView {
  return { id, capability, name, configured, model: `${capability}-model`, baseURL: 'https://api.example.test/v1' }
}
const chat = service(chatId, 'chat', 'Personal chat')
const image = service(imageId, 'image', 'Image studio')
const video = service(videoId, 'video', 'Video studio')

function run(owner: ServiceView, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'saved-run' as RunId, service: owner, startedAt: Date.UTC(2026, 10, 20, 8), status: 'completed',
    request: { serviceId: owner.id, messages: [{ role: 'user', content: 'original prompt' }] },
    frames: [{ type: 'done' }], ...overrides,
  }
}

function mount(options: {
  catalog?: Partial<CatalogState>
  interaction?: Partial<InteractionState>
  history?: Partial<HistoryState>
  dictionary?: typeof en | typeof zh
  actions?: Partial<ImageStudioProps>
} = {}) {
  let catalog: CatalogState = { phase: 'ready', services: [chat, image, video], mutation: 'idle', ...options.catalog }
  let interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle', ...options.interaction }
  let history: HistoryState = { phase: 'ready', records: [], ...options.history }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const dictionary = options.dictionary ?? en
  const actions = {
    refresh: vi.fn<ImageStudioProps['refresh']>(async () => {}),
    save: vi.fn<ImageStudioProps['save']>(async () => true),
    remove: vi.fn<ImageStudioProps['remove']>(async () => true),
    select: vi.fn<ImageStudioProps['select']>(),
    submit: vi.fn<ImageStudioProps['submit']>(async () => false),
    uploadReference: vi.fn<ImageStudioProps['uploadReference']>(async () => undefined),
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
    t: makeTranslate(dictionary), ...options.actions,
  }
  const view = render(<ImageStudio {...props} />)
  return {
    ...view, ...actions,
    update(values: { catalog?: Partial<CatalogState>; interaction?: Partial<InteractionState>; history?: Partial<HistoryState> }) {
      catalog = { ...catalog, ...values.catalog }
      interaction = { ...interaction, ...values.interaction }
      history = { ...history, ...values.history }
      view.rerender(<ImageStudio {...props} />)
    },
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('image studio', () => {
  it('points at the settings section when no image service is configured', () => {
    mount({ catalog: { services: [chat] }, dictionary: zh })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh.imageStudio)
    expect(screen.getByText(zh.imageStudioSetup)).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(zh.imageStudioSelectService) })).toBeNull()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh.imageStudioPrompt }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.generate }).disabled).toBe(true)
  })

  it('offers only configured image services and remembers the chosen one', () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.imageStudioSelectService}`) }))
    expect(screen.getByRole('menuitem', { name: image.name })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: chat.name })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: video.name })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: image.name }))
    expect(view.select).toHaveBeenCalledExactlyOnceWith(imageId)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('submits the typed prompt once and clears it only after a confirmed completion', async () => {
    const view = mount()
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt })
    fireEvent.change(input, { target: { value: 'A red fox in snow' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))
    await waitFor(() => {
      expect(view.submit).toHaveBeenCalledExactlyOnceWith('A red fox in snow', '', '', undefined, undefined, 'A red fox in snow')
    })
    expect(input.value).toBe('A red fox in snow')
    view.submit.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))
    await waitFor(() => { expect(input.value).toBe('') })
    view.update({ interaction: { phase: 'running' } })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt }).disabled).toBe(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.stop }))
    expect(view.stop).toHaveBeenCalledOnce()
  })

  it('reports a failed run with its safe message and code but no provider text', () => {
    mount({ interaction: {
      phase: 'failed', error: 'requestError', errorCode: 'DIRECT_AI_IMAGE_FAILED',
      frames: [{ type: 'text', text: 'raw provider body' }, { type: 'progress', status: 'provider status' }],
    } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en.requestError)
    expect(alert.textContent).toContain('DIRECT_AI_IMAGE_FAILED')
    expect(screen.queryByText('raw provider body')).toBeNull()
    expect(screen.queryByText('provider status')).toBeNull()
  })

  it('renders every generated image with an attachment link and ignores text frames', () => {
    mount({ interaction: { phase: 'completed', frames: [
      { type: 'text', text: 'raw provider body' },
      { type: 'media', url: 'api/direct-ai/media?id=first', mime: 'image/png' },
      { type: 'media', url: 'api/direct-ai/media?id=second', mime: 'image/webp' },
      { type: 'done' },
    ] } })
    const images = screen.getAllByRole('img', { name: en.result })
    expect(images.map(item => item.getAttribute('src'))).toEqual(['api/direct-ai/media?id=first', 'api/direct-ai/media?id=second'])
    expect(screen.getAllByRole('link', { name: en.download })[0]?.getAttribute('href'))
      .toBe(new URL('api/direct-ai/media?id=first&download=1', document.baseURI).href)
    expect(screen.queryByText('raw provider body')).toBeNull()
  })

  it('filters recent generations to image runs and restores one for viewing', () => {
    const imageRun = run(image, {
      id: 'image-run' as RunId,
      frames: [{ type: 'media', url: 'api/direct-ai/media?id=history', mime: 'image/png' }, { type: 'done' }],
    })
    const chatRun = run(chat, { id: 'chat-run' as RunId, frames: [{ type: 'text', text: 'chat answer' }, { type: 'done' }] })
    const view = mount({ history: { records: [chatRun, imageRun] } })
    fireEvent.click(screen.getByText(en.imageStudioRecent))
    expect(screen.getByText(image.name)).toBeTruthy()
    expect(screen.queryByText(chat.name)).toBeNull()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: new RegExp(image.model) }))
    expect(view.restore).toHaveBeenCalledExactlyOnceWith(imageRun)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a generated image at full size and closes the preview', () => {
    mount({ interaction: { phase: 'completed', frames: [
      { type: 'media', url: 'api/direct-ai/media?id=zoom', mime: 'image/png' }, { type: 'done' },
    ] } })
    fireEvent.click(screen.getByRole('button', { name: en.imageStudioViewerDialog }))
    const dialog = screen.getByRole('dialog', { name: en.imageStudioViewerDialog })
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('api/direct-ai/media?id=zoom')
    fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('returns to the conversation from the mode bar', () => {
    const view = mount()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.imageStudio }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.chat }))
    expect(view.backToAgent).toHaveBeenCalledOnce()
  })
})
