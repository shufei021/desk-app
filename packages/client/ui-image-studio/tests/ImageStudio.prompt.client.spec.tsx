// @vitest-environment jsdom
/** Paired prompt/result display: the retained description, history titles, restore and prompt actions. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectFrame, ImageReference, RunId, RunRecord, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
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
const startedAt = Date.UTC(2026, 10, 20, 8)
const media: readonly DirectFrame[] = [
  { type: 'media', url: 'api/direct-ai/media?id=paired', mime: 'image/png' }, { type: 'done' },
]

function reference(name: string): ImageReference {
  return {
    attachmentId: `${name}-attachment` as ImageReference['attachmentId'],
    mediaType: 'image/png', bytes: 4, width: 1, height: 1, name,
  }
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'paired-run' as RunId, service: image, startedAt, status: 'completed',
    request: {
      serviceId: imageId, messages: [{ role: 'user', content: 'A lake at dawn' }], displayPrompt: 'A lake at dawn',
    },
    frames: [...media], ...overrides,
  }
}

const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`)
const revokeObjectUrl = vi.fn<(url: string) => void>()
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
let previousCreate: PropertyDescriptor | undefined
let previousRevoke: PropertyDescriptor | undefined
let previousClipboard: PropertyDescriptor | undefined

beforeEach(() => {
  createObjectUrl.mockClear()
  revokeObjectUrl.mockClear()
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  previousCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  previousRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(() => {
  cleanup()
  if (previousCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
  else Object.defineProperty(URL, 'createObjectURL', previousCreate)
  if (previousRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
  else Object.defineProperty(URL, 'revokeObjectURL', previousRevoke)
  if (previousClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', previousClipboard)
  vi.restoreAllMocks()
})

/**
 * Mount the studio over a driven controller: submitted runs and restored history update the interaction
 * the way the real controller does, then repaint.
 */
function mount(options: { history?: readonly RunRecord[]; interaction?: Partial<InteractionState> } = {}) {
  const catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle' }
  let interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle', ...options.interaction }
  const history: HistoryState = { phase: 'ready', records: [...(options.history ?? [])] }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  let repaint = (): void => {}
  const actions = {
    refresh: vi.fn<ImageStudioProps['refresh']>(async () => {}),
    save: vi.fn<ImageStudioProps['save']>(async () => true),
    remove: vi.fn<ImageStudioProps['remove']>(async () => true),
    select: vi.fn<ImageStudioProps['select']>(),
    submit: vi.fn<ImageStudioProps['submit']>(async (prompt, _system, _parameters, references, _mask, displayPrompt) => {
      interaction = {
        serviceId: imageId, messages: [{ role: 'user', content: prompt }], frames: [...media], phase: 'completed',
        run: {
          ...displayPrompt === undefined ? {} : { displayPrompt },
          serviceName: image.name, model: image.model, startedAt, referenceCount: references?.length ?? 0,
        },
      }
      repaint()
      return true
    }),
    restore: vi.fn<ImageStudioProps['restore']>((restored) => {
      interaction = {
        serviceId: restored.service.id, messages: restored.request.messages, frames: restored.frames,
        phase: restored.status === 'running' ? 'failed' : restored.status,
        run: {
          ...restored.request.displayPrompt === undefined ? {} : { displayPrompt: restored.request.displayPrompt },
          serviceName: restored.service.name, model: restored.service.model, startedAt: restored.startedAt,
          referenceCount: restored.request.references?.length ?? 0,
        },
      }
      repaint()
    }),
    uploadReference: vi.fn<ImageStudioProps['uploadReference']>(async (file: File) => reference(file.name)),
    stop: vi.fn(), clear: vi.fn(), backToAgent: vi.fn(),
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

function card(): HTMLElement {
  return screen.getByRole('region', { name: en.promptLabel })
}

function choosePreset(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.generationMode}`) }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

function openHistory(): void {
  fireEvent.click(screen.getByText(en.imageStudioRecent))
}

describe('image studio prompt pairing', () => {
  it('shows the submitted description and its metadata instead of the preset template', async () => {
    const view = mount()
    const description = '同一只红狐狸，雪地里'
    fireEvent.change(promptBox(), { target: { value: description } })
    fireEvent.change(view.picker(), {
      target: { files: [new File([Uint8Array.of(1)], 'fox.png', { type: 'image/png' })] },
    })
    await waitFor(() => { expect(screen.getAllByRole('img', { name: en.references })).toHaveLength(1) })
    choosePreset(en.presetCharacterTurnaround)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.generate }))

    await waitFor(() => { expect(card()).toBeTruthy() })
    const shown = card()
    expect(shown.textContent).toContain(description)
    expect(shown.textContent).not.toContain(PROMPT_TEMPLATES.characterTurnaround)
    expect(shown.textContent).toContain(image.name)
    expect(shown.textContent).toContain(image.model)
    expect(shown.textContent).toContain(en.referencesUsed.replace('{count}', '1'))
    expect(shown.textContent).toContain(en.presetUsed.replace('{name}', en.presetCharacterTurnaround))
    // The provider prompt still carries the template; only the retained description stays out of it.
    expect(view.submit.mock.calls[0]?.[0]).toContain(PROMPT_TEMPLATES.characterTurnaround)
    expect(view.submit.mock.calls[0]?.[5]).toBe(description)
  })

  it('expands and collapses a prompt that does not fit two lines', async () => {
    const long = 'A very long description '.repeat(12).trim()
    mount({ history: [record({
      id: 'long-run' as RunId, request: { serviceId: imageId, messages: [{ role: 'user', content: long }], displayPrompt: long },
    })] })
    openHistory()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(long.slice(0, 24)) }))
    const expand = screen.getByRole<HTMLButtonElement>('button', { name: en.expandPrompt })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    const collapse = screen.getByRole<HTMLButtonElement>('button', { name: en.collapsePrompt })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(collapse)
    expect(screen.getByRole('button', { name: en.expandPrompt })).toBeTruthy()
  })

  it('falls back to the retained request message when no description was saved', () => {
    const fallback = 'R'.repeat(400)
    mount({ history: [record({
      id: 'legacy-run' as RunId,
      request: { serviceId: imageId, messages: [{ role: 'user', content: fallback }] },
    })] })
    openHistory()
    // A run without a retained description is titled with its model instead.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(image.model) }))
    expect(card().textContent).toContain(`${'R'.repeat(280)}…`)
    expect(card().textContent).not.toContain(fallback)
  })

  it('titles each recent generation with the first line of its prompt', () => {
    mount({ history: [
      record({ id: 'first-line' as RunId, request: {
        serviceId: imageId, messages: [{ role: 'user', content: 'A lake at dawn\n\nwith reeds' }],
        displayPrompt: 'A lake at dawn\n\nwith reeds',
      } }),
      record({ id: 'long-title' as RunId, startedAt: startedAt + 1000, request: {
        serviceId: imageId, messages: [{ role: 'user', content: 'L'.repeat(120) }], displayPrompt: 'L'.repeat(120),
      } }),
    ] })
    openHistory()
    expect(screen.getByText('A lake at dawn')).toBeTruthy()
    expect(screen.getByText(`${'L'.repeat(60)}…`)).toBeTruthy()
  })

  it('restores the result and its prompt together from history', () => {
    const retained = record({ id: 'restored-run' as RunId })
    const view = mount({ history: [retained] })
    openHistory()
    fireEvent.click(screen.getByRole('button', { name: /A lake at dawn/ }))
    expect(view.restore).toHaveBeenCalledExactlyOnceWith(retained)
    expect(card().textContent).toContain('A lake at dawn')
    expect(screen.getAllByRole('img', { name: en.result }).map(item => item.getAttribute('src')))
      .toContain('api/direct-ai/media?id=paired')
  })

  it('reuses the prompt in the composer without submitting it', () => {
    const view = mount({ history: [record()] })
    openHistory()
    fireEvent.click(screen.getByRole('button', { name: /A lake at dawn/ }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.reusePrompt }))
    expect(promptBox().value).toBe('A lake at dawn')
    expect(document.activeElement).toBe(promptBox())
    expect(view.submit).not.toHaveBeenCalled()
  })

  it('copies the prompt and reports the clipboard outcome', async () => {
    mount({ history: [record()] })
    openHistory()
    fireEvent.click(screen.getByRole('button', { name: /A lake at dawn/ }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.copyPrompt }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledExactlyOnceWith('A lake at dawn') })
    expect(screen.getByText(en.promptCopied)).toBeTruthy()

    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.copyPrompt }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.promptCopyFailed) })
  })
})
