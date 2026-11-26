/** Independent successful-image output delegates loading and preview to the Session-authorized gallery. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './image-result-node.ts'
import css from './ImageSettings.module.css'

/** The Chat node's derived owner share and the image feature's locale, without a second subscription. */
export type ImageResultNodeProps = PropsRuntime<'conversation.chat.node', 'generated-images'>
  & PropsLocale<'imageGeneration'> & PropsRenderFactories

/** @param props - persisted generation output and the owner's authorized image loader. @returns an always-visible result gallery. */
export function ImageResultNode({ node, loadImage, renderFactorySlot, t }: ImageResultNodeProps): ReactNode {
  return <section className={css.result} aria-label={t('generated')}>
    <p className={css.resultTitle} role="status">{t('imageCount', { count: String(node.data.images.length) })}</p>
    {node.data.summary && <p className={css.resultText}>{node.data.summary}</p>}
    {renderFactorySlot('conversation.images.content', {
      images: node.data.images.map(attachment => ({ attachment })), loadImage, align: 'start',
    })}
  </section>
}
