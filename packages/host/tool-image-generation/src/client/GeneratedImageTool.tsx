/** Generated images remain visible in the conversation through the shared authorized image gallery. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ImageSettings.module.css'

/** Tool-stage owner data plus a locale seat and framework gallery renderer. */
export type GeneratedImageToolProps = ToolCallViewProps & PropsLocale<'imageGeneration'> & PropsRenderFactories

/** @param props - durable tool result and authorized attachment loader. @returns pending/error copy or an expanded image gallery. */
export function GeneratedImageTool({ phase, block, loadImage, renderFactorySlot, t }: GeneratedImageToolProps): ReactNode {
  if (phase !== 'result' || !('kind' in block)) {
    return <section className={css.result} aria-label={t('generating')}><p className={css.resultTitle} role="status">
      {t(phase === 'preparing' ? 'preparing' : 'generating')}</p></section>
  }
  const images: MessageImageSource[] = []
  const texts: string[] = []
  for (const part of block.content) {
    if (part.type === 'image') images.push({ attachment: part.attachment })
    else if (part.type === 'text') texts.push(part.text)
  }
  return <section className={css.result} aria-label={t(block.isError ? 'failed' : 'generated')}>
    <p className={block.isError ? css.error : css.resultTitle} role={block.isError ? 'alert' : 'status'}>
      {t(block.isError ? 'failed' : images.length > 0 ? 'imageCount' : 'noImage', { count: String(images.length) })}</p>
    {texts.map((text, index) => <p key={index} className={css.resultText}>{text}</p>)}
    {images.length > 0 && renderFactorySlot('conversation.images.content', { images, loadImage, align: 'start' })}
  </section>
}
