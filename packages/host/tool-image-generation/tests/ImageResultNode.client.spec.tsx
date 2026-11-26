// @vitest-environment jsdom
/** Successful output is visible without expanding tool work, using only the Chat owner's authorized loader. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { ImageResultNode, type ImageResultNodeProps } from '../src/client/ImageResultNode.tsx'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

const image: ImageAttachmentRef = { attachmentId: brandString<AttachmentId>('sha256:generated'), mediaType: 'image/png',
  bytes: 20, width: 4, height: 4 }
afterEach(() => { cleanup() })

it('renders the gallery immediately beside a success summary without a disclosure control', () => {
  const factory = vi.fn<ImageResultNodeProps['renderFactorySlot']>(() => <div data-testid="output-gallery" />)
  const loadImage = vi.fn(async () => 'blob:authorized')
  const props: ImageResultNodeProps = { ...({} as GlobalStandardProps & SessionStandardProps),
    renderFactorySlot: factory, loadImage, t: makeTranslate(en),
    openFile: vi.fn(), inspectCall: undefined, forkAt: vi.fn(), useTurnData: () => undefined,
    useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }), useGroupAction: () => ({ current: null }),
    node: { key: 'generated-images:call', kind: 'generated-images', id: 'call', target: 'chat', anchorSeq: 4,
      visibility: 'visible', location: { kind: 'unresolved' }, groupTree: 'turn',
      data: { images: [image], summary: 'A generated landscape', runId: 'run-1' } } }
  render(<ImageResultNode {...props} />)
  expect(screen.getByRole('status').textContent).toBe('1 image(s) generated')
  expect(screen.getByText('A generated landscape')).toBeTruthy()
  expect(screen.getByTestId('output-gallery')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(factory).toHaveBeenCalledWith('conversation.images.content', { images: [{ attachment: image }], loadImage, align: 'start' })
  expect(loadImage).not.toHaveBeenCalled()
})
