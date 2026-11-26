// @vitest-environment jsdom
/** Variant comparison panel: batch controls, serial progress, result columns and prompt adoption. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectFrame, DirectRequest, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type { VariantStream } from '../src/client/variants.ts'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const imageId = 'image-service' as ServiceId
const image: ServiceView = {
  id: imageId, capability: 'image', name: 'Image studio', configured: true,
  model: 'image-model', baseURL: 'https://api.example.test/v1',
}

/** A provider stream whose frames and settlement the spec drives. */
class ManualStream implements VariantStream {
  private readonly frames: DirectFrame[] = []
  private waiter: { resolve: (result: IteratorResult<DirectFrame>) => void; reject: (error: unknown) => void } | undefined
  private finished = false
  private failure: { error: Error } | undefined

  push(frame: DirectFrame): void {
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter.resolve({ done: false, value: frame })
      return
    }
    this.frames.push(frame)
  }

  close(): void {
    this.finished = true
    const waiter = this.waiter
    if (waiter === undefined) return
    this.waiter = undefined
    waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    const waiter = this.waiter
    this.finished = true
    if (waiter === undefined) {
      this.failure = { error }
      return
    }
    this.waiter = undefined
    waiter.reject(error)
  }

  dispose(): void { this.close() }

  [Symbol.asyncIterator](): AsyncIterator<DirectFrame> { return this }

  next(): Promise<IteratorResult<DirectFrame>> {
    const failure = this.failure
    if (failure !== undefined) {
      this.failure = undefined
      return Promise.reject(failure.error)
    }
    const frame = this.frames.shift()
    if (frame !== undefined) return Promise.resolve({ done: false, value: frame })
    if (this.finished) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }
}

/** One opened style stream, with the request and cancellation the batch used. */
interface OpenedStyle {
  readonly request: DirectRequest
  readonly signal: AbortSignal
  readonly stream: ManualStream
}

function mount() {
  const catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle' }
  const interaction: InteractionState = { serviceId: imageId, messages: [], frames: [], phase: 'idle' }
  const history: HistoryState = { phase: 'ready', records: [] }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const opened: OpenedStyle[] = []
  // The transport ends a stream when its signal aborts; the stub mirrors that.
  const variantRun = vi.fn<ImageStudioProps['variantRun']>((request, signal) => {
    const stream = new ManualStream()
    signal.addEventListener('abort', () => { stream.dispose() }, { once: true })
    opened.push({ request, signal, stream })
    return stream
  })
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
    variantRun,
  }
  const props: ImageStudioProps = {
    ...({} as GlobalStandardProps), ...actions,
    useCatalog: select => select(catalog), useInteraction: select => select(interaction),
    useHistory: select => select(history), useDirectory: select => select(directory),
    t: makeTranslate(en),
  }
  render(<ImageStudio {...props} />)
  return { ...actions, opened }
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.imageStudioPrompt })
}

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: en.variants }))
  return screen.getByRole('region', { name: en.variants })
}

function startButton(panel: HTMLElement): HTMLButtonElement {
  return within(panel).getByRole<HTMLButtonElement>('button', { name: en.variantStart })
}

/** Push frames into one style's stream and end it, as the provider would. */
function settle(stream: ManualStream, frames: readonly DirectFrame[]): void {
  act(() => {
    for (const frame of frames) stream.push(frame)
    stream.close()
  })
}

function resultImages(panel: HTMLElement): readonly HTMLElement[] {
  return within(panel).getAllByRole('img', { name: en.result })
}

/** The stream one opened style index owns; the spec fails loudly if the batch stopped early. */
function streamOf(opened: readonly OpenedStyle[], index: number): ManualStream {
  const entry = opened[index]
  if (entry === undefined) throw new Error(`variant batch opened no style at index ${index}`)
  return entry.stream
}

beforeEach(() => { window.localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('variant comparison panel', () => {
  it('opens from the tool row with the default count and styles, and starts only with a description', () => {
    mount()
    const panel = openPanel()
    expect(within(panel).getByText(en.variantEmpty)).toBeTruthy()
    expect(startButton(panel).disabled).toBe(true)
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '3' }).getAttribute('aria-pressed')).toBe('true')
    const styles = within(within(panel).getByRole('group', { name: en.variantStyles }))
      .getAllByRole<HTMLInputElement>('checkbox')
    expect(styles.map(box => box.checked)).toEqual([true, true, true, false, false])

    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    expect(startButton(panel).disabled).toBe(false)

    fireEvent.click(within(panel).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('region', { name: en.variants })).toBeNull()
  })

  it('runs the checked styles up to the chosen count, one at a time, and fills a column per style', async () => {
    const view = mount()
    const panel = openPanel()
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(within(panel).getByRole('button', { name: '2' }))
    fireEvent.click(startButton(panel))

    // Only the first style streams until it settles; the count caps a wider checked selection.
    expect(view.opened).toHaveLength(1)
    expect(view.opened[0]?.request.messages.at(-1)?.content).toBe('一只橘猫，写实摄影质感，自然光')
    expect(view.opened[0]?.request.parametersJson).toBeUndefined()
    expect(within(panel).getByRole('status').textContent)
      .toBe(en.variantProgress.replace('{current}', '1').replace('{total}', '2'))

    settle(streamOf(view.opened, 0), [
      { type: 'media', url: 'api/direct-ai/media?id=photo-1', mime: 'image/png' },
      { type: 'media', url: 'api/direct-ai/media?id=photo-2', mime: 'image/png' },
      { type: 'done' },
    ])
    await waitFor(() => { expect(view.opened).toHaveLength(2) })
    expect(view.opened[1]?.request.messages.at(-1)?.content).toBe('一只橘猫，电影感画面，戏剧性布光，宽银幕构图')
    await waitFor(() => {
      expect(within(panel).getByRole('status').textContent)
        .toBe(en.variantProgress.replace('{current}', '2').replace('{total}', '2'))
    })

    settle(streamOf(view.opened, 1), [
      { type: 'media', url: 'api/direct-ai/media?id=cinematic', mime: 'image/png' }, { type: 'done' },
    ])
    await waitFor(() => { expect(resultImages(panel)).toHaveLength(3) })
    // The batch finished, so the start control is available again and no progress remains.
    expect(screen.queryByText(en.variantProgress.replace('{current}', '2').replace('{total}', '2'))).toBeNull()
    expect(startButton(panel).disabled).toBe(false)
    // A column with several images numbers its download links.
    expect(within(panel).getAllByRole('link').map(link => link.textContent)).toEqual([
      `${en.download} 1`, `${en.download} 2`, en.download,
    ])
    const grid = within(panel).getByRole('list')
    expect(within(grid).getAllByRole('button', { name: en.variantUse })).toHaveLength(2)
    expect(view.submit).not.toHaveBeenCalled()
  })

  it('shows a failed column with its provider code and keeps generating the later styles', async () => {
    const view = mount()
    const panel = openPanel()
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(within(panel).getByRole('button', { name: '2' }))
    fireEvent.click(startButton(panel))

    act(() => { streamOf(view.opened, 0).fail(Object.assign(new Error('rejected'), { code: 'DIRECT_AI_HTTP_FAILED' })) })
    await waitFor(() => { expect(view.opened).toHaveLength(2) })
    settle(streamOf(view.opened, 1), [
      { type: 'media', url: 'api/direct-ai/media?id=cinematic', mime: 'image/png' }, { type: 'done' },
    ])

    const alert = await within(panel).findByRole('alert')
    expect(alert.textContent).toContain(en.variantFailed)
    expect(alert.textContent).toContain('DIRECT_AI_HTTP_FAILED')
    await waitFor(() => { expect(resultImages(panel)).toHaveLength(1) })
    // The failed column keeps its name and offers no image to adopt.
    const grid = within(panel).getByRole('list')
    const uses = within(grid).getAllByRole<HTMLButtonElement>('button', { name: en.variantUse })
    expect(uses.map(button => button.disabled)).toEqual([true, false])
  })

  it('writes a column prompt into the description, closes the panel and submits nothing', async () => {
    const view = mount()
    const panel = openPanel()
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(within(panel).getByRole('button', { name: '2' }))
    fireEvent.click(startButton(panel))
    settle(streamOf(view.opened, 0), [
      { type: 'media', url: 'api/direct-ai/media?id=photo', mime: 'image/png' }, { type: 'done' },
    ])
    await waitFor(() => { expect(view.opened).toHaveLength(2) })
    settle(streamOf(view.opened, 1), [
      { type: 'media', url: 'api/direct-ai/media?id=cinematic', mime: 'image/png' }, { type: 'done' },
    ])
    await waitFor(() => { expect(resultImages(panel)).toHaveLength(2) })

    const grid = within(panel).getByRole('list')
    fireEvent.click(within(grid).getAllByRole<HTMLButtonElement>('button', { name: en.variantUse })[1] as HTMLElement)

    expect(promptBox().value).toBe('一只橘猫，电影感画面，戏剧性布光，宽银幕构图')
    expect(screen.queryByRole('region', { name: en.variants })).toBeNull()
    expect(view.submit).not.toHaveBeenCalled()
    // Adopting a finished column spends no further provider request.
    expect(view.variantRun).toHaveBeenCalledTimes(2)
  })

  it('stops the running batch, aborts the open stream and keeps the settled column', async () => {
    const view = mount()
    const panel = openPanel()
    fireEvent.change(promptBox(), { target: { value: '一只橘猫' } })
    fireEvent.click(within(panel).getByRole('button', { name: '2' }))
    fireEvent.click(startButton(panel))
    settle(streamOf(view.opened, 0), [
      { type: 'media', url: 'api/direct-ai/media?id=photo', mime: 'image/png' }, { type: 'done' },
    ])
    await waitFor(() => { expect(view.opened).toHaveLength(2) })

    fireEvent.click(within(panel).getByRole('button', { name: en.variantStop }))
    await waitFor(() => { expect(within(panel).getByText(en.cancelled)).toBeTruthy() })

    expect(view.opened[1]?.signal.aborted).toBe(true)
    expect(resultImages(panel)).toHaveLength(1)
    expect(within(panel).queryByRole('button', { name: en.variantStop })).toBeNull()
    expect(startButton(panel).disabled).toBe(false)
    // Stopping never started a third style.
    expect(view.opened).toHaveLength(2)
  })
})
