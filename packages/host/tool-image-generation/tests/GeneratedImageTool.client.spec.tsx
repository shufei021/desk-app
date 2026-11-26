// @vitest-environment jsdom
/** Tool image presentation delegates bytes and preview ownership to the authorized gallery Factory. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { GeneratedImageTool, type GeneratedImageToolProps } from '../src/client/GeneratedImageTool.tsx'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

const image: ImageAttachmentRef = { attachmentId: 'sha256:image' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png',
  width: 1024, height: 1024, bytes: 40 }
function fixture(isError = false) {
  const factory = vi.fn<GeneratedImageToolProps['renderFactorySlot']>(() => <div data-testid="gallery" />)
  const loadImage = vi.fn(async () => 'blob:authorized')
  const props: GeneratedImageToolProps = { ...({} as GlobalStandardProps & SessionStandardProps), phase: 'result', toolName: 'generate_image',
    callId: 'call', openFile: vi.fn(), useDisclosure: vi.fn(), loadImage, renderFactorySlot: factory, t: makeTranslate(en),
    block: { kind: 'tool-result', seq: 5, time: 10, callId: 'call', name: 'generate_image', args: PartialArguments.EMPTY,
      call: null, callTime: null, content: [{ type: 'text', text: 'Provider result' }, { type: 'image', attachment: image }],
      isError, subCalls: [] } }
  return { props, factory, loadImage }
}
afterEach(() =>{  cleanup() })

it('shows successful images expanded by default with the owner authorized loader', () => {
  const f = fixture()
  render(<GeneratedImageTool {...f.props} />)
  expect(screen.getByTestId('gallery')).toBeTruthy()
  expect(screen.getByText('Provider result')).toBeTruthy()
  expect(f.factory).toHaveBeenCalledWith('conversation.images.content', { images: [{ attachment: image }], loadImage: f.loadImage, align: 'start' })
  expect(f.loadImage).not.toHaveBeenCalled()
})

it('retains image content and error feedback when a partial output failed', () => {
  const f = fixture(true)
  render(<GeneratedImageTool {...f.props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.failed)
  expect(screen.getByTestId('gallery')).toBeTruthy()
})

it('keeps pending generation visible without synthesizing image output', () => {
  const f = fixture()
  render(<GeneratedImageTool {...f.props} phase="start" block={{ phase: 'start', name: 'generate_image', callId: 'call',
    args: PartialArguments.EMPTY, argsRaw: '{}', turn: 1, step: 1, subCalls: [], time: 5 }} />)
  expect(screen.getByRole('status').textContent).toBe(en.generating)
  expect(f.factory).not.toHaveBeenCalled()
})
