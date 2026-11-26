/** Image output survives replay and history paging without joining the collapsed tool process. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createToolResultMessage, type ContentBlock, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { chatViewDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { imageResultDefinition } from '../src/client/image-result-node.ts'

const image: ImageAttachmentRef = { attachmentId: brandString<AttachmentId>('sha256:generated'), mediaType: 'image/png',
  bytes: 20, width: 4, height: 4 }
const callId = brandString<ToolCallId>('generate-call')
function at<Type extends SessionEvent['type']>(seq: number, type: Type, data: SessionEvent<Type>['data']): SessionEventLikeEntry {
  return { type: 'event', event: { seq, time: seq, type, data } as SessionEvent<Type> }
}
function result(seq = 4, content: readonly ContentBlock[] = [{ type: 'text', text: 'Generated image' }, { type: 'image', attachment: image }],
  isError = false, id = callId): SessionEventLikeEntry {
  return at(seq, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id, content, isError }),
    meta: { runId: 'run-1', images: [{ attachmentId: 'not-an-image-source' }] } })
}
const start = [at(1, 'turn/start', { turn: 1 }), at(2, 'step/start', { turn: 1, step: 1 }),
  at(3, 'tool/call', { turn: 1, step: 1, callId, name: 'generate_image', arguments: '{}' })]
function assembler(entries: readonly SessionEventLikeEntry[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler({ entries: () => [imageResultDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] })
  value.replaceWindow(entries, hasMore)
  value.activateTarget('chat')
  value.flush()
  return value
}
function nodes(value: ConversationNodeAssembler): ChatNode<'generated-images'>[] {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return [...snapshot.nodes.values()].filter((node): node is ChatNode<'generated-images'> => node.kind === 'generated-images')
}

it('creates an independent result row from image content, not arbitrary metadata', () => {
  const value = assembler([...start, result()])
  const node = nodes(value)[0]
  expect(node).toMatchObject({ kind: 'generated-images', id: callId, anchorSeq: 4, groupTree: 'turn', visibility: 'visible',
    location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } }, data: { images: [image], summary: 'Generated image', runId: 'run-1' } })
  expect(nodes(value)).toHaveLength(1)
})

it('produces the same row for live completion, replay and prepending an older call', () => {
  const replay = assembler([...start, result()])
  const live = assembler(start)
  expect(nodes(live)).toHaveLength(0)
  live.append(result())
  live.flush()
  const paged = assembler([result()], true)
  expect(nodes(paged)).toHaveLength(0)
  paged.prepend(start, false)
  paged.flush()
  const output = (value: ConversationNodeAssembler) => nodes(value).map(({ location, ...node }) => ({ ...node,
    location: location.kind === 'step' ? { kind: location.kind, turn: location.turn.turn, step: location.step.step } : location }))
  expect(output(live)).toEqual(output(replay))
  expect(output(paged)).toEqual(output(replay))
  live.append(at(5, 'step/end', { turn: 1, step: 1 }))
  live.append(at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  live.flush()
  expect(nodes(live)[0]).toMatchObject({ groupTree: 'turn', location: { turn: { status: 'closed' } } })
})

it('does not synthesize output from an unrelated tool, failures, or image-free results', () => {
  const other = at(3, 'tool/call', { turn: 1, step: 1, callId, name: 'read_image', arguments: '{}' })
  expect(nodes(assembler([...start.slice(0, 2), other, result()]))).toHaveLength(0)
  expect(nodes(assembler([...start, result(4, [], false)]))).toHaveLength(0)
  expect(nodes(assembler([...start, result(4, [{ type: 'image', attachment: image }], true)]))).toHaveLength(0)
  expect(imageResultDefinition.match(at(10, 'step/end', { turn: 1, step: 1 }).event)).toBeNull()
})
