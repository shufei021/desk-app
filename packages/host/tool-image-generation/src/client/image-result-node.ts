/** Project successful generation results into independent Chat output rows, outside process disclosure. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Durable result content, independent of the tool card's collapsed process. */
export interface ImageResultData {
  readonly images: readonly ImageAttachmentRef[]
  readonly summary: string
  readonly runId?: string
}

interface ImageResultState {
  readonly result?: { readonly seq: number; readonly data: ImageResultData }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Generated image output shown alongside the Assistant response. */
    'generated-images': ImageResultData
  }
}

/** A result cannot name its tool, so its call supplies identity and its own content supplies every image. */
export const imageResultDefinition: ConversationNodeDefinition<ImageResultState> = {
  kind: 'generated-images',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'generate_image') return { id: event.data.callId, role: 'start' }
    if (event.type === 'tool/result') return { id: event.data.message.toolCallId, role: 'update' }
    return null
  },
  start: () => ({}),
  update: (context, match) => {
    if (match.event.type !== 'tool/result' || match.event.data.message.isError) return context.state
    const images: ImageAttachmentRef[] = []
    const texts: string[] = []
    for (const part of match.event.data.message.content) {
      if (part.type === 'image') images.push(part.attachment)
      else if (part.type === 'text') texts.push(part.text)
    }
    if (images.length === 0) return context.state
    const meta = match.event.data.meta
    const runId = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && typeof meta.runId === 'string'
      ? meta.runId : undefined
    return { result: { seq: match.event.seq, data: { images, summary: texts.join('\n'),
      ...(runId === undefined ? {} : { runId }) } } }
  },
  buildViewNode: (context): ChatNode<'generated-images'> | null => {
    const result = context.state?.result
    if (result === undefined) return null
    return { key: context.key, id: context.id, kind: 'generated-images', target: 'chat',
      anchorSeq: result.seq, location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible', groupTree: 'turn', data: result.data }
  },
}
