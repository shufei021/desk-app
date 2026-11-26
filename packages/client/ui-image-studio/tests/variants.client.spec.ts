/** Serial variant batches: prompt suffixes, provider parameters, failure isolation and cancellation. */
import { describe, expect, it, vi } from 'vitest'
import type { DirectFrame, DirectRequest, ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import { runVariants, type VariantRun, type VariantStream } from '../src/client/variants.ts'
import type { VariantStyleId } from '../src/client/variant-styles.ts'

const serviceId = 'image-service' as ServiceId
const parametersJson = '{"size":"1024x1024","quality":"high","n":1}'

/** A provider stream that yields the given frames once and then ends. */
function framesStream(frames: readonly DirectFrame[]): VariantStream {
  return {
    dispose: () => {},
    async *[Symbol.asyncIterator]() { for (const frame of frames) yield frame },
  }
}

/** Provider failure carrying a stable code, the way the Remote surfaces a rejected request. */
function codedError(code: string): Error {
  return Object.assign(new Error('provider rejected the request'), { code })
}

/** Read the styled prompt one request carries. */
function promptOf(request: DirectRequest): string {
  return request.messages.at(-1)?.content ?? ''
}

describe('variant batch', () => {
  it('runs one style at a time and appends each style suffix to the description', async () => {
    const events: string[] = []
    const requests: DirectRequest[] = []
    const openRun: VariantRun = (request) => {
      requests.push(request)
      const index = requests.length
      events.push(`open:${index}`)
      return {
        dispose: () => { events.push(`dispose:${index}`) },
        async *[Symbol.asyncIterator]() {
          yield { type: 'media', url: `api/direct-ai/media?id=${index}`, mime: 'image/png' }
          events.push(`finish:${index}`)
          yield { type: 'done' }
        },
      }
    }
    const seen: string[] = []
    const outcomes = await runVariants({
      serviceId, base: '  一只橘猫 ', styleIds: ['photo', 'cinematic'], parametersJson,
      signal: new AbortController().signal, openRun,
    }, {
      onOutcome: (outcome) => { seen.push(outcome.styleId) },
    })

    // The second style opens only after the first stream was consumed and disposed.
    expect(events).toEqual(['open:1', 'finish:1', 'dispose:1', 'open:2', 'finish:2', 'dispose:2'])
    expect(requests.map(promptOf)).toEqual([
      '一只橘猫，写实摄影质感，自然光',
      '一只橘猫，电影感画面，戏剧性布光，宽银幕构图',
    ])
    // History shows the exact styled prompt each variant submitted.
    expect(requests.map(request => request.displayPrompt)).toEqual(requests.map(promptOf))
    expect(requests[0]?.parametersJson).toBe(parametersJson)
    expect(requests[0]?.serviceId).toBe(serviceId)
    expect(outcomes).toEqual([
      { styleId: 'photo', status: 'done', images: ['api/direct-ai/media?id=1'] },
      { styleId: 'cinematic', status: 'done', images: ['api/direct-ai/media?id=2'] },
    ])
    expect(seen).toEqual(['photo', 'cinematic'])
  })

  it('records a failed style with its provider reason and keeps running the later styles', async () => {
    const requests: DirectRequest[] = []
    const openRun: VariantRun = (request) => {
      requests.push(request)
      const prompt = promptOf(request)
      if (prompt.includes('插画')) throw codedError('DIRECT_AI_HTTP_FAILED')
      if (prompt.includes('水彩')) {
        return {
          dispose: () => {},
          async *[Symbol.asyncIterator]() { throw new Error('socket closed') },
        }
      }
      // An error without a usable reason still fails the column, without inventing text.
      if (prompt.includes('3D')) {
        return {
          dispose: () => {},
          async *[Symbol.asyncIterator]() { throw new Error('') },
        }
      }
      // A stream that ends without a done frame is a failure, not a success.
      return framesStream([{ type: 'media', url: 'api/direct-ai/media?id=short', mime: 'image/png' }])
    }
    const outcomes = await runVariants({
      serviceId, base: '一只橘猫',
      styleIds: ['photo', 'illustration', 'watercolor', 'render3d'], parametersJson: '',
      signal: new AbortController().signal, openRun,
    })

    expect(outcomes).toEqual([
      { styleId: 'photo', status: 'failed', images: ['api/direct-ai/media?id=short'] },
      { styleId: 'illustration', status: 'failed', images: [], error: 'DIRECT_AI_HTTP_FAILED' },
      { styleId: 'watercolor', status: 'failed', images: [], error: 'socket closed' },
      { styleId: 'render3d', status: 'failed', images: [] },
    ])
    // A blank composer selection sends no parameters and leaves them to the provider.
    expect(requests.map(request => request.parametersJson)).toEqual([undefined, undefined, undefined, undefined])
    expect(requests).toHaveLength(4)
  })

  it('stops every later style when the batch signal aborts after a settled column', async () => {
    const controller = new AbortController()
    const opened: VariantStyleId[] = []
    const openRun: VariantRun = () => {
      opened.push('photo')
      return framesStream([
        { type: 'media', url: 'api/direct-ai/media?id=1', mime: 'image/png' }, { type: 'done' },
      ])
    }
    const outcomes = await runVariants({
      serviceId, base: '一只橘猫', styleIds: ['photo', 'illustration', 'watercolor'], parametersJson,
      signal: controller.signal, openRun,
    }, {
      onOutcome: () => { controller.abort() },
    })

    expect(opened).toHaveLength(1)
    expect(outcomes).toEqual([{ styleId: 'photo', status: 'done', images: ['api/direct-ai/media?id=1'] }])
  })

  it('drops the interrupted column and runs no later style when the signal aborts mid-stream', async () => {
    const controller = new AbortController()
    const opened: string[] = []
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started = (): void => {}
    const streaming = new Promise<void>((resolve) => { started = resolve })
    const openRun: VariantRun = (request, signal) => {
      opened.push(promptOf(request))
      return {
        dispose: () => { release() },
        async *[Symbol.asyncIterator]() {
          yield { type: 'media', url: 'api/direct-ai/media?id=photo', mime: 'image/png' }
          signal.addEventListener('abort', () => { release() }, { once: true })
          started()
          await blocked
          // A frame that arrives after the cancellation is ignored and ends the style.
          yield { type: 'done' }
        },
      }
    }
    const pending = runVariants({
      serviceId, base: '一只橘猫', styleIds: ['photo', 'cinematic'], parametersJson,
      signal: controller.signal, openRun,
    })
    await streaming
    controller.abort()

    // The interrupted style produced no confirmed result, so it contributes no column.
    expect(await pending).toEqual([])
    expect(opened).toEqual(['一只橘猫，写实摄影质感，自然光'])
  })

  it('omits the retained display prompt once the styled prompt exceeds the Host bound', async () => {
    const requests: DirectRequest[] = []
    const openRun: VariantRun = (request) => {
      requests.push(request)
      return framesStream([{ type: 'done' }])
    }
    await runVariants({
      serviceId, base: '猫'.repeat(3990), styleIds: ['photo'], parametersJson: '',
      signal: new AbortController().signal, openRun,
    })

    const request = requests[0]
    if (request === undefined) throw new Error('the batch opened no style')
    // The provider still receives the full styled prompt; only the retained display text is dropped.
    expect(promptOf(request)).toBe(`${'猫'.repeat(3990)}，写实摄影质感，自然光`)
    expect(request.displayPrompt).toBeUndefined()
  })

  it('runs nothing when the batch signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const openRun = vi.fn<VariantRun>(() => framesStream([{ type: 'done' }]))
    const onOutcome = vi.fn()
    const outcomes = await runVariants({
      serviceId, base: '一只橘猫', styleIds: ['photo', 'cinematic'], parametersJson,
      signal: controller.signal, openRun,
    }, { onOutcome })

    expect(outcomes).toEqual([])
    expect(openRun).not.toHaveBeenCalled()
    expect(onOutcome).not.toHaveBeenCalled()
  })
})
