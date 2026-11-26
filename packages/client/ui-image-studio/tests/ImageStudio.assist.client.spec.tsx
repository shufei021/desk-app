// @vitest-environment jsdom
/** Prompt assistant streaming and the parameter suggestion bar in the image workspace. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import { IMAGE_PARAMS_KEY } from '../src/client/image-params.ts'
import { PROMPT_ASSIST_SERVICE_KEY } from '../src/client/prompt-assist.ts'
import type { AssistOutcome, CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const imageId = 'image-service' as ServiceId
const chatId = 'chat-service' as ServiceId
const otherChatId = 'other-chat' as ServiceId
const image: ServiceView = {
  id: imageId, capability: 'image', name: 'Image studio', configured: true,
  model: 'image-model', baseURL: 'https://api.example.test/v1',
}
const chat: ServiceView = {
  id: chatId, capability: 'chat', name: 'Personal chat', configured: true,
  model: 'chat-model', baseURL: 'https://api.example.test/v1',
}
const otherChat: ServiceView = { ...chat, id: otherChatId, name: 'Second chat' }

function mount(options: {
  services?: readonly ServiceView[]
  assistChat?: ImageStudioProps['assistChat']
} = {}) {
  const catalog: CatalogState = { phase: 'ready', services: [...(options.services ?? [image, chat])], mutation: 'idle' }
  const interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle' }
  const history: HistoryState = { phase: 'ready', records: [] }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const assistChat = vi.fn<ImageStudioProps['assistChat']>(
    options.assistChat ?? (async () => ({ status: 'completed' })),
  )
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
    assistChat,
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
  return { ...actions, assistChat }
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt })
}

function assistButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: en.promptAssist })
}

function suggestionBar(): HTMLElement | null {
  return screen.queryByRole('group', { name: en.suggestions })
}

/** A controllable stream: the stub reports text on demand and settles on the test's command. */
function controlledAssist() {
  let push: ((text: string) => void) | undefined
  let settle: ((outcome: AssistOutcome) => void) | undefined
  const assistChat = vi.fn<ImageStudioProps['assistChat']>((_serviceId, _system, _prompt, onText) => {
    push = onText
    onText('全景宽幅')
    return new Promise<AssistOutcome>((resolve) => { settle = resolve })
  })
  return {
    assistChat,
    push(text: string): void { push?.(text) },
    settle(outcome: AssistOutcome): void { settle?.(outcome) },
  }
}

beforeEach(() => { window.localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('prompt assistant', () => {
  it('disables the assistant without a chat service and describes the missing setup', () => {
    mount({ services: [image] })
    const button = assistButton()
    expect(button.disabled).toBe(true)
    const hint = screen.getByText(en.promptAssistNoService)
    expect(button.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('streams an expanded prompt and adopts it without submitting', async () => {
    const stream = controlledAssist()
    const view = mount({ assistChat: stream.assistChat })
    expect(assistButton().disabled).toBe(false)

    fireEvent.click(assistButton())
    const panel = screen.getByRole('region', { name: en.promptAssist })
    const expand = within(panel).getByRole<HTMLButtonElement>('button', { name: en.promptAssistExpand })
    expect(expand.disabled).toBe(true)
    expect(within(panel).getByText(en.promptAssistEmpty)).toBeTruthy()

    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(expand)
    expect(await within(panel).findByText('全景宽幅')).toBeTruthy()
    expect(view.assistChat).toHaveBeenCalledOnce()
    expect(view.assistChat.mock.calls[0]?.[0]).toBe(chatId)
    expect(view.assistChat.mock.calls[0]?.[2]).toBe('一只橘猫')

    act(() => { stream.push('全景宽幅电影感的城市夜景') })
    expect(await within(panel).findByText('全景宽幅电影感的城市夜景')).toBeTruthy()

    const adopt = within(panel).getByRole<HTMLButtonElement>('button', { name: en.promptAssistAdopt })
    expect(adopt.disabled).toBe(true)
    act(() => { stream.settle({ status: 'completed' }) })
    await waitFor(() => { expect(adopt.disabled).toBe(false) })

    fireEvent.click(adopt)
    expect(promptBox().value).toBe('全景宽幅电影感的城市夜景')
    expect(view.submit).not.toHaveBeenCalled()
    // The panel stays open so the user can regenerate or close it explicitly.
    expect(screen.getByRole('region', { name: en.promptAssist })).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: en.promptAssistRegenerate }))
    expect(view.assistChat).toHaveBeenCalledTimes(2)
  })

  it('remembers the chosen chat service and closes the panel', () => {
    mount({ services: [image, chat, otherChat] })
    fireEvent.click(assistButton())
    const panel = screen.getByRole('region', { name: en.promptAssist })
    fireEvent.click(within(panel).getByRole('button', { name: `${en.promptAssistService}: ${chat.name}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: otherChat.name }))
    expect(window.localStorage.getItem(PROMPT_ASSIST_SERVICE_KEY)).toBe(otherChatId)

    fireEvent.click(within(panel).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('region', { name: en.promptAssist })).toBeNull()

    // Reopening starts from the remembered service.
    fireEvent.click(assistButton())
    expect(screen.getByRole('button', { name: `${en.promptAssistService}: ${otherChat.name}` })).toBeTruthy()
  })

  it('aborts the stream when the panel closes', async () => {
    let signal: AbortSignal | undefined
    const assistChat = vi.fn<ImageStudioProps['assistChat']>((_serviceId, _system, _prompt, onText, abort) => {
      signal = abort
      onText('全景宽幅')
      return new Promise<AssistOutcome>(() => {})
    })
    mount({ assistChat })
    fireEvent.click(assistButton())
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(screen.getByRole('button', { name: en.promptAssistExpand }))
    expect(await screen.findByText('全景宽幅')).toBeTruthy()
    expect(signal?.aborted).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(screen.queryByRole('region', { name: en.promptAssist })).toBeNull()
    expect(signal?.aborted).toBe(true)
  })

  it('keeps the assistant usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied') })
    mount({ services: [image, chat, otherChat] })
    fireEvent.click(assistButton())
    const panel = screen.getByRole('region', { name: en.promptAssist })
    fireEvent.click(within(panel).getByRole('button', { name: `${en.promptAssistService}: ${chat.name}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: otherChat.name }))
    // The choice stays in page state even though the browser refused to store it.
    expect(within(panel).getByRole('button', { name: `${en.promptAssistService}: ${otherChat.name}` })).toBeTruthy()
  })

  it('stops the stream locally and keeps the partial text', async () => {
    const stream = controlledAssist()
    mount({ assistChat: stream.assistChat })
    fireEvent.click(assistButton())
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(screen.getByRole('button', { name: en.promptAssistExpand }))
    expect(await screen.findByText('全景宽幅')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.promptAssistStop }))
    act(() => { stream.settle({ status: 'cancelled' }) })
    expect(screen.queryByRole('button', { name: en.promptAssistStop })).toBeNull()
    expect(screen.getByText('全景宽幅')).toBeTruthy()
  })

  it('reports a localized failure with its provider code and does not retry', async () => {
    const assistChat = vi.fn<ImageStudioProps['assistChat']>(
      async () => ({ status: 'failed', errorCode: 'DIRECT_AI_HTTP_FAILED' }),
    )
    const view = mount({ assistChat })
    fireEvent.click(assistButton())
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(screen.getByRole('button', { name: en.promptAssistExpand }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(en.promptAssistFailed)
    expect(alert.textContent).toContain('DIRECT_AI_HTTP_FAILED')
    expect(view.assistChat).toHaveBeenCalledOnce()
    expect(view.submit).not.toHaveBeenCalled()
  })

  it('reports a rejected stream as a failure without a provider code', async () => {
    const assistChat = vi.fn<ImageStudioProps['assistChat']>(async () => { throw new Error('stream unavailable') })
    mount({ assistChat })
    fireEvent.click(assistButton())
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(screen.getByRole('button', { name: en.promptAssistExpand }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(en.promptAssistFailed)
  })
})

describe('parameter suggestion bar', () => {
  it('suggests, applies and persists parameters, then hides the dismissed suggestion', async () => {
    const view = mount()
    fireEvent.change(promptBox(), { target: { value: '全景宽幅电影感的城市夜景，高清细节' } })
    const bar = suggestionBar()
    expect(bar).not.toBeNull()
    const summary = bar?.querySelector('p')?.textContent ?? ''
    expect(summary).toContain('21:9')
    expect(summary).toContain('4K')
    expect(summary).toContain('high')
    expect(summary).toContain('1')
    expect(view.submit).not.toHaveBeenCalled()

    fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: en.suggestionApply }))
    expect(suggestionBar()).toBeNull()
    expect(view.submit).not.toHaveBeenCalled()
    expect(JSON.parse(window.localStorage.getItem(IMAGE_PARAMS_KEY) ?? '{}'))
      .toMatchObject({ ratio: '21:9', resolution: '4K', quality: 'high', count: 1, width: 3840, height: 1648 })

    fireEvent.click(screen.getByRole('button', { name: en.imageParams }))
    const dialog = screen.getByRole('dialog', { name: en.imageParamsTitle })
    expect(within(dialog).getByRole('button', { name: '21:9' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(dialog).getByRole('button', { name: '4K' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(dialog).getAllByRole('button', { name: en.close })[0] as HTMLElement)

    fireEvent.change(promptBox(), { target: { value: '竖版人像海报' } })
    const next = suggestionBar()
    expect(next).not.toBeNull()
    expect(next?.textContent).toContain('9:16')
    fireEvent.click(within(next as HTMLElement).getByRole('button', { name: en.suggestionIgnore }))
    expect(suggestionBar()).toBeNull()

    // Editing the dismissed description brings the new suggestion back.
    fireEvent.change(promptBox(), { target: { value: '竖版人像海报全身' } })
    expect(suggestionBar()).not.toBeNull()
  })

  it('never suggests while the description is empty', () => {
    mount()
    expect(suggestionBar()).toBeNull()
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    expect(suggestionBar()).not.toBeNull()
    fireEvent.change(promptBox(), { target: { value: '' } })
    expect(suggestionBar()).toBeNull()
  })
})
