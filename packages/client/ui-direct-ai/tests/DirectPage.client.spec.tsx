// @vitest-environment jsdom
/** Direct UI behavior with controller-owned snapshots; no Agent or workspace inputs are supplied. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { Capability, ModelDirectory, RunId, RunRecord, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { DirectPage, type DirectPageProps } from '../src/client/DirectPage.tsx'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

const chatId = 'chat-service' as ServiceId
const imageId = 'image-service' as ServiceId
const videoId = 'video-service' as ServiceId
const otherChatId = 'other-chat' as ServiceId
function service(id: ServiceId, capability: Capability, name: string, configured = true): ServiceView {
  return { id, capability, name, configured, model: `${capability}-model`, baseURL: 'https://api.example.test/v1', endpoint: `${capability}/custom` }
}
const chat = service(chatId, 'chat', 'Personal chat')
const image = service(imageId, 'image', 'Image studio')
const video = service(videoId, 'video', 'Video studio')
const otherChat = service(otherChatId, 'chat', 'Second chat')
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'saved-run' as RunId, service: chat, startedAt: Date.UTC(2026, 10, 20, 8), status: 'completed',
    request: { serviceId: chatId, messages: [{ role: 'system', content: 'original system' }, { role: 'user', content: 'original prompt' }], parametersJson: '{"temperature":0.2}' },
    frames: [{ type: 'text', text: 'original answer' }, { type: 'done' }], ...overrides,
  }
}

function mount(options: {
  catalog?: Partial<CatalogState>
  interaction?: Partial<InteractionState>
  history?: Partial<HistoryState>
  directory?: DirectoryState
  dictionary?: typeof en | typeof zh
  actions?: Partial<DirectPageProps>
} = {}) {
  let catalog: CatalogState = { phase: 'ready', services: [chat, image, video], mutation: 'idle', ...options.catalog }
  let interaction: InteractionState = { serviceId: chatId, messages: [], frames: [], phase: 'idle', ...options.interaction }
  let history: HistoryState = { phase: 'ready', records: [], ...options.history }
  let directory: DirectoryState = options.directory ?? { phase: 'idle', value: undefined }
  const dictionary = options.dictionary ?? en
  const actions = {
    refresh: vi.fn<DirectPageProps['refresh']>(async () => {}),
    save: vi.fn<DirectPageProps['save']>(async () => true),
    remove: vi.fn<DirectPageProps['remove']>(async () => true),
    select: vi.fn<DirectPageProps['select']>(),
    submit: vi.fn<DirectPageProps['submit']>(async () => false),
    uploadReference: vi.fn<DirectPageProps['uploadReference']>(async () => undefined),
    stop: vi.fn(), clear: vi.fn(), restore: vi.fn(), backToAgent: vi.fn(),
    discoverModels: vi.fn<DirectPageProps['discoverModels']>(async () => true), clearDirectory: vi.fn(),
  }
  const props: DirectPageProps = {
    ...({} as GlobalStandardProps), ...actions,
    useCatalog: select => select(catalog), useInteraction: select => select(interaction), useHistory: select => select(history),
    useDirectory: select => select(directory),
    t: makeTranslate(dictionary), ...options.actions,
  }
  const view = render(<DirectPage {...props} />)
  return {
    ...view, ...actions,
    update(values: {
      catalog?: Partial<CatalogState>
      interaction?: Partial<InteractionState>
      history?: Partial<HistoryState>
      directory?: DirectoryState
    }) {
      if (values.catalog !== undefined) {
        const { error: _previousError, ...retained } = catalog
        catalog = { ...retained, ...values.catalog }
      }
      interaction = { ...interaction, ...values.interaction }
      history = { ...history, ...values.history }
      if (values.directory !== undefined) directory = values.directory
      view.rerender(<DirectPage {...props} />)
    },
  }
}

const directoryValue: ModelDirectory = { source: 'aiyoyoo-public', fetchedAt: 1,
  groups: [{ id: 4, name: 'Gateway group', platform: 'gemini', description: '' }],
  models: [{ id: 'catalog-image-model', platform: 'anthropic', groupId: 4, groupName: 'Gateway group' }],
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function openAdvanced(): void { fireEvent.click(screen.getByText(en.advanced)) }
function enterRequiredServiceFields(): void {
  fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.name }), { target: { value: 'New service' } })
  fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.baseURL }), { target: { value: 'https://new.example.test/v1' } })
  fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.model }), { target: { value: 'user-model' } })
}

describe('Direct AI page', () => {
  it('shows only explicitly configured capabilities and keeps unconfigured services editable', () => {
    const view = mount({ catalog: { services: [chat, { ...image, configured: false }] }, dictionary: zh })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh.title)
    expect(screen.getByRole('tab', { name: zh.chat })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: zh.image })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh.video })).toBeNull()
    expect(screen.getByText(zh.missingKey)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: `${zh.edit} ${image.name}` }).disabled).toBe(false)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: zh.agent }))
    expect(view.backToAgent).toHaveBeenCalledOnce()
  })

  it('renders loading, empty, catalog failures and retained rows without confusing them', () => {
    const view = mount({ catalog: { phase: 'loading', services: [] }, interaction: { serviceId: undefined } })
    expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    expect(screen.queryByText(en.noServices)).toBeNull()
    view.update({ catalog: { phase: 'ready' } })
    expect(screen.getByText(en.noServices)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.add }).disabled).toBe(false)
    view.update({ catalog: { phase: 'error', error: 'loadError', services: [chat] } })
    expect(screen.getByRole('alert').textContent).toBe(en.loadError)
    expect(screen.getByText(chat.name)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.add }).disabled).toBe(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.retry }))
    expect(view.refresh).toHaveBeenCalledOnce()
  })

  it('retains partial raw text through cancellation and errors while locking destructive changes during requests', () => {
    const view = mount({ interaction: {
      phase: 'running', messages: [{ role: 'user', content: '<script>original input</script>' }], frames: [{ type: 'text', text: '<img src=x>partial response' }],
    }, history: { records: [run()] } })
    expect(screen.getByText('<img src=x>partial response')).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()
    expect(screen.getByText(en.videoNotice)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.add }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.newChat }).disabled).toBe(true)
    for (const tab of screen.getAllByRole('tab')) expect((tab as HTMLButtonElement).disabled).toBe(true)
    for (const row of screen.getAllByRole('button', { name: /^(Edit|Delete) / })) expect((row as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: `${en.selectService} ${chat.name}` }).disabled).toBe(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.stop }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.agent }))
    expect(view.stop).toHaveBeenCalledOnce()
    expect(view.backToAgent).toHaveBeenCalledOnce()
    view.update({ interaction: { phase: 'cancelled' } })
    expect(screen.getByText(en.cancelled)).toBeTruthy()
    expect(screen.getByText('<img src=x>partial response')).toBeTruthy()
    view.update({ interaction: { phase: 'failed', error: 'streamEnded', errorCode: `DIRECT_AI_${'LONG_'.repeat(30)}` } })
    expect(screen.getByRole('alert').textContent).toContain(en.streamEnded)
    expect(screen.getByText('<img src=x>partial response')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.newChat }).disabled).toBe(false)
  })

  it('keeps drafts scoped to their service and changes capabilities through controller selection', () => {
    const view = mount({ catalog: { services: [chat, otherChat, image] } })
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }), { target: { value: 'chat draft' } })
    fireEvent.click(screen.getByRole('tab', { name: en.image }))
    expect(view.select).toHaveBeenLastCalledWith(imageId)
    view.update({ interaction: { serviceId: imageId } })
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('')
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }), { target: { value: 'image draft' } })
    openAdvanced()
    expect(screen.queryByRole('textbox', { name: en.system })).toBeNull()
    view.update({ interaction: { serviceId: chatId } })
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('chat draft')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: `${en.selectService} ${chat.name}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: otherChat.name }))
    expect(view.select).toHaveBeenLastCalledWith(otherChatId)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.newChat }))
    expect(view.clear).toHaveBeenCalledOnce()
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('')
  })

  it('submits only explicit drafts, rejects non-object parameters, and clears text only on confirmed completion', async () => {
    const view = mount()
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }), { target: { value: 'next question' } })
    openAdvanced()
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.system }), { target: { value: 'only my system' } })
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.parameters }), { target: { value: '[]' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.send }))
    expect(screen.getByRole('alert').textContent).toBe(en.invalidJson)
    expect(view.submit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.parameters }), { target: { value: '{"temperature":0.3}' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.send }))
    await waitFor(() => { expect(view.submit).toHaveBeenCalledExactlyOnceWith('next question', 'only my system', '{"temperature":0.3}') })
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('next question')
    view.submit.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.send }))
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('') })
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.system }).value).toBe('only my system')
  })

  it('renders provider media, progress and download links without rewriting provider output', () => {
    const view = mount({ interaction: { serviceId: imageId, phase: 'completed', frames: [
      { type: 'media', url: '/api/direct-ai/media/image', mime: 'image/png' }, { type: 'done' },
    ] } })
    expect(screen.getByRole('img', { name: en.result }).getAttribute('src')).toBe('/api/direct-ai/media/image')
    expect(screen.getByRole('link', { name: en.download }).getAttribute('href')).toBe(new URL('/api/direct-ai/media/image?download=1', document.baseURI).href)
    fireEvent.error(screen.getByRole('img', { name: en.result }))
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    expect(screen.getByRole('link', { name: en.download })).toBeTruthy()
    view.update({ interaction: { serviceId: videoId, phase: 'running', frames: [
      { type: 'progress', status: 'provider original status', progress: 35 },
      { type: 'media', url: '/api/direct-ai/media/video', mime: 'video/mp4' },
    ] } })
    expect(screen.getByText('provider original status')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('35')
    expect(view.container.querySelector('video')?.controls).toBe(true)
    expect(screen.getByText(en.videoNotice)).toBeTruthy()
  })

  it('shows history outcomes and restores inputs for viewing without submitting them', () => {
    const record = run()
    const view = mount({ history: { records: [record] } })
    fireEvent.click(screen.getByText(en.history))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: `${en.restore} ${chat.name}` }))
    expect(view.restore).toHaveBeenCalledExactlyOnceWith(record)
    expect(view.submit).not.toHaveBeenCalled()
    openAdvanced()
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.system }).value).toBe('original system')
    expect(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.parameters }).value).toBe(record.request.parametersJson)
    view.update({ history: { phase: 'error' } })
    expect(screen.getByRole('alert').textContent).toBe(en.historyError)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.retry }))
    expect(view.refresh).toHaveBeenCalledOnce()
  })

  it('displays historical results when their service is deleted and keeps sending unavailable', () => {
    mount({ catalog: { services: [] }, interaction: {
      serviceId: chatId, phase: 'failed', messages: [{ role: 'user', content: 'retained prompt' }],
      frames: [{ type: 'text', text: 'retained partial' }], error: 'requestError',
    } })
    expect(screen.getByText('retained partial')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(en.requestError)
    expect(screen.queryByRole('button', { name: en.send })).toBeNull()
  })
})

describe('Service editor and deletion', () => {
  it('validates new credentials, URL and JSON before saving and clears the key before awaiting the Host', async () => {
    let settle: (value: boolean) => void = () => {}
    const saved = new Promise<boolean>((resolve) => { settle = resolve })
    const view = mount()
    view.save.mockReturnValueOnce(saved)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.add }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.save }))
    expect(screen.getByRole('alert').textContent).toBe(en.required)
    enterRequiredServiceFields()
    const keyField = screen.getByLabelText<HTMLInputElement>(en.apiKey)
    expect(keyField.value).toBe('')
    expect(keyField.getAttribute('autocomplete')).toBe('new-password')
    fireEvent.change(keyField, { target: { value: 'write-only-test-key' } })
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.baseURL }), { target: { value: 'http://public.example.test/v1' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.save }))
    expect(screen.getByRole('alert').textContent).toBe(en.invalidURL)
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.baseURL }), { target: { value: 'http://127.0.0.1:8000/v1' } })
    fireEvent.change(within(screen.getByRole('dialog')).getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.parameters }), { target: { value: 'null' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.save }))
    expect(screen.getByRole('alert').textContent).toBe(en.invalidJson)
    expect(view.save).not.toHaveBeenCalled()
    fireEvent.change(within(screen.getByRole('dialog')).getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.parameters }), { target: { value: '{"size":"1024x1024"}' } })
    fireEvent.click(screen.getByRole('radio', { name: en.imageProtocol }))
    fireEvent.change(screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: en.endpoint }), { target: { value: 'images/generations' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.save }))
    expect(view.save).toHaveBeenCalledExactlyOnceWith({
      name: 'New service', baseURL: 'http://127.0.0.1:8000/v1', model: 'user-model', capability: 'image', apiKey: 'write-only-test-key',
      endpoint: 'images/generations', parametersJson: '{"size":"1024x1024"}',
    })
    expect(keyField.value).toBe('')
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { settle(false); await saved })
    expect(screen.getByRole('dialog')).toBeTruthy()
    view.update({ catalog: { error: 'saveError' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en.retry }))
    expect(view.refresh).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits a blank replacement key on edit, closes only on acknowledgement, and never fills a saved key', async () => {
    const view = mount()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: `${en.edit} ${chat.name}` }))
    expect(screen.getByLabelText<HTMLInputElement>(en.apiKey).value).toBe('')
    expect(screen.getByPlaceholderText(en.keyKeep)).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.save }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(view.save).toHaveBeenCalledExactlyOnceWith({ id: chatId, name: chat.name, baseURL: chat.baseURL, model: chat.model, capability: 'chat', endpoint: chat.endpoint })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: `${en.edit} ${chat.name}` }))
    expect(screen.getByLabelText<HTMLInputElement>(en.apiKey).value).toBe('')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.apiKey), { target: { value: 'discarded-draft-key' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: `${en.edit} ${chat.name}` }))
    expect(screen.getByLabelText<HTMLInputElement>(en.apiKey).value).toBe('')
  })

  it('prefills the gateway without replacing the draft key and reads its public directory before a key exists', () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('button', { name: en.publicDirectory }))
    expect(view.discoverModels).toHaveBeenLastCalledWith({ kind: 'aiyoyoo-public' })
    fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'local-draft-only' } })
    fireEvent.click(screen.getByRole('radio', { name: en.videoProtocol }))
    fireEvent.change(screen.getByRole('textbox', { name: en.endpoint }), { target: { value: 'custom-path' } })
    fireEvent.click(screen.getByRole('button', { name: en.aiyoyooPreset }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.baseURL }).value).toBe('https://www.aiyoyoo.com/v1')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.name }).value).toBe(en.aiyoyooPreset)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.endpoint }).value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>(en.apiKey).value).toBe('local-draft-only')
    expect(screen.getByRole<HTMLInputElement>('radio', { name: en.chatProtocol }).checked).toBe(true)
    expect(screen.getByText(en.aiyoyooPresetHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.customPreset }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.baseURL }).value).toBe('https://www.aiyoyoo.com/v1')
  })

  it('uses a draft key for new discovery without clearing it, and saves selected annotations without inferring capability', async () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    enterRequiredServiceFields()
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    expect(view.discoverModels).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en.directoryKeyRequired)
    fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'write-only-directory-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    expect(view.discoverModels).toHaveBeenLastCalledWith({ kind: 'draft', baseURL: 'https://new.example.test/v1', apiKey: 'write-only-directory-key' })
    expect(screen.getByLabelText<HTMLInputElement>(en.apiKey).value).toBe('write-only-directory-key')
    view.update({ directory: { phase: 'ready', value: { ...directoryValue, source: 'provider' } } })
    fireEvent.click(screen.getByRole('button', { name: /catalog-image-model/ }))
    expect(screen.getByRole<HTMLInputElement>('radio', { name: en.chatProtocol }).checked).toBe(true)
    expect(view.save).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: en.groupLabel }), { target: { value: 'My local group name' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(view.save).toHaveBeenCalledExactlyOnceWith({
      name: 'New service', baseURL: 'https://new.example.test/v1', model: 'catalog-image-model', capability: 'chat',
      apiKey: 'write-only-directory-key', platform: 'anthropic', groupId: 4, groupName: 'My local group name',
    }) })
  })

  it('only reuses a saved key at the normalized saved address and prefers an explicit replacement draft', () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: `${en.edit} ${chat.name}` }))
    fireEvent.change(screen.getByRole('textbox', { name: en.baseURL }), { target: { value: 'https://API.example.test:443/v1/' } })
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    expect(view.discoverModels).toHaveBeenLastCalledWith({ kind: 'saved', serviceId: chatId })
    fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'replacement-draft' } })
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    expect(view.discoverModels).toHaveBeenLastCalledWith({ kind: 'draft', baseURL: 'https://API.example.test:443/v1/', apiKey: 'replacement-draft' })
    fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: '' } })
    fireEvent.change(screen.getByRole('textbox', { name: en.baseURL }), { target: { value: 'https://other.example.test/v1' } })
    expect(screen.getByText(en.changedURLKeyHint)).toBeTruthy()
    view.discoverModels.mockClear()
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(view.discoverModels).not.toHaveBeenCalled()
    expect(view.save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en.directoryKeyRequired)
  })

  it('hides old directory results immediately on source, address, key and capability changes and clears on close', () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('button', { name: en.publicDirectory }))
    view.update({ directory: { phase: 'ready', value: directoryValue } })
    expect(screen.getByRole('button', { name: /catalog-image-model/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: en.baseURL }), { target: { value: 'https://next.example.test/v1' } })
    expect(screen.queryByRole('button', { name: /catalog-image-model/ })).toBeNull()
    fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'new-draft' } })
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    expect(screen.queryByRole('button', { name: /catalog-image-model/ })).toBeNull()
    view.update({ directory: { phase: 'ready', value: { ...directoryValue, source: 'provider' } } })
    expect(screen.getByRole('button', { name: /catalog-image-model/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'another-draft' } })
    expect(screen.queryByRole('button', { name: /catalog-image-model/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.keyDirectory }))
    view.update({ directory: { phase: 'ready', value: { ...directoryValue, source: 'provider' } } })
    fireEvent.click(screen.getByRole('radio', { name: en.imageProtocol }))
    expect(screen.queryByRole('button', { name: /catalog-image-model/ })).toBeNull()
    const cleared = view.clearDirectory.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(view.clearDirectory).toHaveBeenCalledTimes(cleared + 1)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByLabelText<HTMLInputElement>(en.apiKey).value).toBe('')
    expect(screen.queryByRole('button', { name: /catalog-image-model/ })).toBeNull()
  })

  it('searches saved service names, model IDs, labels and URLs with exact platform and group facets', () => {
    const view = mount({ catalog: { services: [
      { ...chat, name: 'Café compact', platform: 'anthropic', groupId: 4, groupName: 'Shared' },
      { ...image, platform: 'openai', groupId: 7, groupName: 'Shared' },
    ] } })
    fireEvent.change(screen.getByRole('searchbox', { name: en.searchServices }), { target: { value: 'cafe cpt anthropic' } })
    expect(screen.getByRole('heading', { name: 'Café compact' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: image.name })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: en.searchServices }), { target: { value: 'example.test' } })
    expect(screen.getByRole('heading', { name: image.name })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Platform: All' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'openai' }))
    expect(screen.queryByRole('heading', { name: 'Café compact' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Platform: openai' }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.all }))
    fireEvent.click(screen.getByRole('button', { name: 'Group: All' }))
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Shared' })[0]!)
    expect(screen.queryByRole('heading', { name: image.name })).toBeNull()
    view.update({ catalog: { services: [image] } })
    expect(screen.getByRole('heading', { name: image.name })).toBeTruthy()
  })

  it('keeps rows on uncertain deletion and requires readback before another delete', async () => {
    const view = mount()
    view.remove.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: `${en.remove} ${chat.name}` }))
    const dialog = screen.getByRole('dialog', { name: en.deleteTitle })
    expect(within(dialog).getByText(en.deleteDescription)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.remove }))
    await waitFor(() => { expect(view.remove).toHaveBeenCalledExactlyOnceWith(chatId) })
    view.update({ catalog: { error: 'removeError' } })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en.remove }).disabled).toBe(true)
    expect(screen.getAllByText(chat.name).length).toBeGreaterThan(0)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en.retry }))
    expect(view.refresh).toHaveBeenCalledOnce()
    view.update({ catalog: { phase: 'ready' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en.remove }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
