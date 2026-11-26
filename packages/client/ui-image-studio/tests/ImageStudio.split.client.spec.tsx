// @vitest-environment jsdom
/** Grid split interaction in the result area; pixel extraction itself is mocked. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { Capability, DirectFrame, ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageStudio, type ImageStudioProps } from '../src/client/ImageStudio.tsx'
import { createFakeAssetLibrary } from './asset-library-stub.client.ts'
import type { CatalogState, DirectoryState, HistoryState, InteractionState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type { GridSplitMessages, SplitTile } from '../src/client/grid-split.ts'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const splitGridImage = vi.hoisted(() => vi.fn<
  (source: CanvasImageSource, width: number, height: number, messages: GridSplitMessages) => Promise<SplitTile[]>
>())

vi.mock('../src/client/grid-split.ts', () => ({ splitGridImage }))

const imageId = 'image-service' as ServiceId
const image = {
  id: imageId, capability: 'image' as Capability, name: 'Image studio', configured: true,
  model: 'image-model', baseURL: 'https://api.example.test/v1',
} satisfies ServiceView

const frame: DirectFrame = { type: 'media', url: 'api/direct-ai/media?id=grid', mime: 'image/png' }

/** Mount the image workspace with one completed media frame. */
function mount(frames: readonly DirectFrame[] = [frame, { type: 'done' }]): void {
  const catalog: CatalogState = { phase: 'ready', services: [image], mutation: 'idle' }
  const interaction: InteractionState = { serviceId: imageId, messages: [], frames: [...frames], phase: 'completed' }
  const history: HistoryState = { phase: 'ready', records: [] }
  const directory: DirectoryState = { phase: 'idle', value: undefined }
  const props: ImageStudioProps = {
    ...({} as GlobalStandardProps),
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
    useCatalog: select => select(catalog), useInteraction: select => select(interaction),
    useHistory: select => select(history), useDirectory: select => select(directory),
    t: makeTranslate(en),
  }
  render(<ImageStudio {...props} />)
}

/** Start one split and return the tiles it will resolve with. */
function deferredTiles(): { promise: Promise<SplitTile[]>; settle: (tiles: SplitTile[]) => void } {
  let settle: (tiles: SplitTile[]) => void = () => {}
  const promise = new Promise<SplitTile[]>((resolve) => { settle = resolve })
  return { promise, settle }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('image grid split', () => {
  it('shows the pending state and then the tile images with download links', async () => {
    const pending = deferredTiles()
    splitGridImage.mockReturnValueOnce(pending.promise)
    const tiles: SplitTile[] = [
      { dataUrl: 'data:image/jpeg;base64,first', name: 'grid-split-1-1.jpg' },
      { dataUrl: 'data:image/jpeg;base64,second', name: 'grid-split-1-2.jpg' },
    ]
    mount()
    fireEvent.click(screen.getByRole('button', { name: en.splitGrid }))
    expect(splitGridImage).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, {
      notFound: en.gridNotFound, tooLarge: en.gridTooLarge, invalid: en.gridInvalid,
    })
    const pendingButton = screen.getByRole<HTMLButtonElement>('button', { name: en.splitting })
    expect(pendingButton.disabled).toBe(true)
    await act(async () => { pending.settle(tiles) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.splitGrid }).disabled).toBe(false)
    const region = screen.getByRole('region', { name: en.splitResult })
    expect(within(region).getAllByRole('img').map(item => item.getAttribute('src')))
      .toEqual(['data:image/jpeg;base64,first', 'data:image/jpeg;base64,second'])
    expect(within(region).getAllByRole('img').map(item => item.getAttribute('alt')))
      .toEqual(['grid-split-1-1.jpg', 'grid-split-1-2.jpg'])
    expect(within(region).getAllByRole('link', { name: en.download }).map(link => [
      link.getAttribute('href'), link.getAttribute('download'),
    ])).toEqual([
      ['data:image/jpeg;base64,first', 'grid-split-1-1.jpg'],
      ['data:image/jpeg;base64,second', 'grid-split-1-2.jpg'],
    ])
  })

  it('reports a failed split inline without opening a dialog', async () => {
    const message = en.gridTooLarge
    splitGridImage.mockRejectedValueOnce(new Error(message))
    mount()
    fireEvent.click(screen.getByRole('button', { name: en.splitGrid }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(message) })
    expect(screen.queryByRole('region', { name: en.splitResult })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.splitGrid }).disabled).toBe(false)
  })

  it('falls back to localized copy when the failure is not an Error', async () => {
    splitGridImage.mockRejectedValueOnce('unexpected failure')
    mount()
    fireEvent.click(screen.getByRole('button', { name: en.splitGrid }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.splitFailed) })
  })

  it('keeps repeated splits as separate sections with only the newest expanded', async () => {
    const first: SplitTile[] = [{ dataUrl: 'data:image/jpeg;base64,first', name: 'grid-split-1-1.jpg' }]
    const second: SplitTile[] = [{ dataUrl: 'data:image/jpeg;base64,second', name: 'grid-split-1-1.jpg' }]
    splitGridImage.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    mount()
    fireEvent.click(screen.getByRole('button', { name: en.splitGrid }))
    await waitFor(() => { expect(screen.getByRole('img', { name: 'grid-split-1-1.jpg' }).getAttribute('src'))
      .toBe('data:image/jpeg;base64,first') })
    fireEvent.click(screen.getByRole('button', { name: en.splitGrid }))
    await waitFor(() => { expect(screen.getByRole('img', { name: 'grid-split-1-1.jpg' }).getAttribute('src'))
      .toBe('data:image/jpeg;base64,second') })
    const regions = screen.getAllByRole('region', { name: en.splitResult })
    expect(regions).toHaveLength(2)
    expect(regions[0]?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(regions[1]?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(regions[0]!).getByRole('button', { name: en.splitResult }))
    expect(screen.getByRole('img', { name: 'grid-split-1-1.jpg' }).getAttribute('src'))
      .toBe('data:image/jpeg;base64,first')
    expect(regions[1]?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  })
})
