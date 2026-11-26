// @vitest-environment jsdom
/** Direct requests preserve user input without Agent instructions, tools, retries, or automatic reconnection. */
import { describe, expect, it, vi } from 'vitest'
import type { Capability, DirectFrame, DirectRequest, ImageReference, RunRecord, ServiceId, ServiceInput, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { configuredCapabilities, DirectController, type DirectRemote, validParameters } from '../src/state.ts'

const id = 'chat-one' as ServiceId
const reference: ImageReference = {
  attachmentId: 'reference-one' as ImageReference['attachmentId'],
  mediaType: 'image/png', bytes: 5, width: 1, height: 1, name: 'sea.png',
}
function service(capability: Capability = 'chat', configured = true): ServiceView {
  return { id, name: 'Personal API', capability, configured, baseURL: 'https://provider.example/v1', model: 'my-model' }
}
function stream(frames: DirectFrame[]): RemoteStreamHandle<DirectFrame, never> {
  return { async *[Symbol.asyncIterator]() { yield* frames }, send() {}, end() {}, dispose() {} }
}
function fixture(options: {
  run?: DirectRemote['run']
  services?: ServiceView[]
  discover?: DirectRemote['discoverModels']
  upload?: DirectRemote['uploadReference']
} = {}) {
  const services = options.services ?? [service()]
  const catalog = vi.fn(async () => ({ ok: true as const, value: services }))
  const save = vi.fn(async (input: ServiceInput) => ({ ok: true as const, value: {
    id: input.id ?? id, name: input.name, capability: input.capability, baseURL: input.baseURL,
    model: input.model, configured: true,
  } }))
  const remove = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const history = vi.fn(async () => ({ ok: true as const, value: [] as RunRecord[] }))
  const run = vi.fn(options.run ?? (() => stream([{ type: 'text', text: 'Hello' }, { type: 'done' }])))
  const discoverModels = vi.fn(options.discover ?? (async () => ({ ok: true as const,
    value: { source: 'provider' as const, models: [], groups: [], fetchedAt: 1 } })))
  const uploadReference = vi.fn(options.upload ?? (async () => ({ ok: true as const, value: reference })))
  const remote: DirectRemote = { catalog, save, removeService: remove, history, run, discoverModels, uploadReference }
  return { controller: new DirectController(remote), remote, catalog, save, remove, run, discoverModels, uploadReference }
}

describe('Direct AI browser controller', () => {
  it('loads explicit directory sources without retaining a draft key', async () => {
    const { controller, discoverModels } = fixture()
    expect(await controller.discoverModels({ kind: 'draft', baseURL: 'https://provider.example/v1', apiKey: 'draft-only-secret' })).toBe(true)
    expect(discoverModels.mock.calls[0]?.[0]).toEqual({ kind: 'draft', baseURL: 'https://provider.example/v1', apiKey: 'draft-only-secret' })
    expect(controller.directory.getSnapshot().phase).toBe('ready')
    expect(JSON.stringify(controller.directory.getSnapshot())).not.toContain('draft-only-secret')
    controller.clearDirectory()
    expect(controller.directory.getSnapshot()).toEqual({ phase: 'idle', value: undefined })
    await controller.dispose()
  })

  it('does not publish a directory response after its editor source was cleared', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<DirectRemote['discoverModels']>>>()
    const { controller } = fixture({ discover: () => pending.promise })
    const reading = controller.discoverModels({ kind: 'aiyoyoo-public' })
    controller.clearDirectory()
    pending.resolve({ ok: true, value: { source: 'aiyoyoo-public', models: [{ id: 'stale', platform: 'openai' }], groups: [], fetchedAt: 1 } })
    expect(await reading).toBe(false)
    expect(controller.directory.getSnapshot()).toEqual({ phase: 'idle', value: undefined })
    await controller.dispose()
  })

  it('shows only explicitly configured capabilities in product order', () => {
    expect(configuredCapabilities([service('video'), service('image', false), service('chat'), service('video')])).toEqual(['chat', 'video'])
    expect(configuredCapabilities([])).toEqual([])
  })

  it('accepts only blank or object parameter JSON', () => {
    for (const text of ['', '  ', '{}', '{"temperature":0.5}']) expect(validParameters(text)).toBe(true)
    for (const text of ['null', '[]', 'true', '1', '{bad}']) expect(validParameters(text)).toBe(false)
  })

  it('sends only explicit messages and preserves multi-turn text without adding tools or a persona', async () => {
    const { controller, run } = fixture()
    await controller.refresh()
    expect(controller.interaction.getSnapshot().serviceId).toBe(id)
    expect(await controller.submit('First', '', '')).toBe(true)
    expect(run.mock.calls[0]?.[0]).toEqual({ serviceId: id, messages: [{ role: 'user', content: 'First' }] })
    expect(await controller.submit('Second', 'My own system', '{"temperature":0}')).toBe(true)
    expect(run.mock.calls[1]?.[0]).toEqual({ serviceId: id, messages: [
      { role: 'system', content: 'My own system' }, { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Second' },
    ], parametersJson: '{"temperature":0}' })
    expect(controller.interaction.getSnapshot().frames).toEqual([{ type: 'text', text: 'Hello' }, { type: 'done' }])
    await controller.dispose()
  })

  it('submits image prompts without chat history or a hidden system message', async () => {
    const { controller, run } = fixture({ services: [service('image')] })
    await controller.refresh()
    await controller.submit('A lake', 'This must not be sent', '{"size":"1024x1024"}')
    expect(run.mock.calls[0]?.[0]).toEqual({ serviceId: id, messages: [{ role: 'user', content: 'A lake' }], parametersJson: '{"size":"1024x1024"}' })
    expect(controller.interaction.getSnapshot().run?.imageParams).toEqual({ size: '1024x1024' })
    await controller.dispose()
  })

  it('carries reference images and a mask only when the request supplies them', async () => {
    const { controller, run } = fixture({ services: [service('image')] })
    await controller.refresh()
    await controller.submit('A lake', '', '', [reference])
    await controller.submit('A lake', '', '', undefined, reference)
    await controller.submit('A lake', '', '')
    expect(run.mock.calls[0]?.[0]).toEqual({ serviceId: id, messages: [{ role: 'user', content: 'A lake' }], references: [reference] })
    expect(run.mock.calls[1]?.[0]).toEqual({ serviceId: id, messages: [{ role: 'user', content: 'A lake' }], mask: reference })
    expect(run.mock.calls[2]?.[0]).not.toHaveProperty('references')
    expect(run.mock.calls[2]?.[0]).not.toHaveProperty('mask')
    await controller.dispose()
  })

  it('retains the user description with the request while sending only the composed prompt', async () => {
    const { controller, run } = fixture({ services: [service('image')] })
    await controller.refresh()
    await controller.submit('A lake at dawn\n\nFixed preset text', '', '', undefined, undefined, '  A lake at dawn  ')
    expect(run.mock.calls[0]?.[0]).toEqual({
      serviceId: id, messages: [{ role: 'user', content: 'A lake at dawn\n\nFixed preset text' }], displayPrompt: 'A lake at dawn',
    })
    expect(controller.interaction.getSnapshot().run).toMatchObject({
      displayPrompt: 'A lake at dawn', serviceName: 'Personal API', model: 'my-model', referenceCount: 0,
    })
    await controller.submit('Second prompt', '', '')
    expect(run.mock.calls[1]?.[0]).not.toHaveProperty('displayPrompt')
    expect(controller.interaction.getSnapshot().run).not.toHaveProperty('displayPrompt')
    await controller.dispose()
  })

  it('restores the retained request description beside its result', async () => {
    const { controller } = fixture({ services: [] })
    const request: DirectRequest = {
      serviceId: id, messages: [{ role: 'user', content: 'A lake at dawn' }], displayPrompt: 'A lake at dawn',
      references: [reference], parametersJson: '{"size":"2048x1152","quality":"high","n":2}',
    }
    const record: RunRecord = {
      id: 'run-paired' as RunRecord['id'], service: service('image'), request, startedAt: 7, status: 'completed',
      frames: [{ type: 'media', url: 'api/direct-ai/media?id=paired', mime: 'image/png' }, { type: 'done' }],
    }
    controller.restore(record)
    expect(controller.interaction.getSnapshot().run).toEqual({
      displayPrompt: 'A lake at dawn', serviceName: 'Personal API', model: 'my-model', startedAt: 7, referenceCount: 1,
      imageParams: { size: '2048x1152', quality: 'high', count: 2 },
    })
    const legacy: RunRecord = { ...record, id: 'run-legacy' as RunRecord['id'], request: { serviceId: id, messages: [{ role: 'user', content: 'Earlier run' }] } }
    controller.restore(legacy)
    expect(controller.interaction.getSnapshot().run).toMatchObject({ serviceName: 'Personal API', referenceCount: 0 })
    expect(controller.interaction.getSnapshot().run).not.toHaveProperty('displayPrompt')
    expect(controller.interaction.getSnapshot().run).not.toHaveProperty('imageParams')
    await controller.dispose()
  })
  it('uploads a selected file as canonical base64 with its declared media type and name', async () => {
    const { controller, uploadReference } = fixture()
    await expect(controller.uploadReference(new File(['hello'], 'sea.png', { type: 'image/png' }))).resolves.toEqual(reference)
    expect(uploadReference.mock.calls[0]?.[0]).toEqual({ data: 'aGVsbG8=', mime: 'image/png', name: 'sea.png' })
    expect(controller.catalog.getSnapshot().error).toBeUndefined()
    await controller.dispose()
  })

  it('returns undefined and publishes only the failure when the Host rejects an upload', async () => {
    const { controller } = fixture({ upload: async () => { throw new Error('host storage failure') } })
    await expect(controller.uploadReference(new File(['hello'], 'sea.png', { type: 'image/png' }))).resolves.toBeUndefined()
    expect(controller.catalog.getSnapshot()).toMatchObject({ services: [], error: 'referenceUploadFailed' })
    expect(JSON.stringify(controller.catalog.getSnapshot())).not.toContain('host storage failure')
    await controller.dispose()
  })

  it('retains partial output and does not retry a failed stream', async () => {
    const { controller, run } = fixture({ run: () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'text' as const, text: 'partial' }; throw Object.assign(new Error('secret must not be shown'), { code: 'PROVIDER_ERROR' }) },
      send() {}, end() {}, dispose() {},
    }) })
    await controller.refresh()
    expect(await controller.submit('Test', '', '')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(controller.interaction.getSnapshot()).toMatchObject({ phase: 'failed', frames: [{ type: 'text', text: 'partial' }], error: 'requestError', errorCode: 'PROVIDER_ERROR' })
    expect(JSON.stringify(controller.interaction.getSnapshot())).not.toContain('secret must not be shown')
    await controller.dispose()
  })

  it('resubmits a failed draft only once in the next explicit request', async () => {
    const { controller, run } = fixture({ run: () => stream([{ type: 'text', text: 'unfinished' }]) })
    await controller.refresh()
    expect(await controller.submit('Same draft', '', '')).toBe(false)
    expect(await controller.submit('Same draft', '', '')).toBe(false)
    expect(run.mock.calls[1]?.[0].messages).toEqual([{ role: 'user', content: 'Same draft' }])
    await controller.dispose()
  })

  it('treats an unconfirmed end as failure rather than completion', async () => {
    const { controller } = fixture({ run: () => stream([{ type: 'text', text: 'unfinished' }]) })
    await controller.refresh()
    expect(await controller.submit('Test', '', '')).toBe(false)
    expect(controller.interaction.getSnapshot()).toMatchObject({ phase: 'failed', error: 'streamEnded' })
    await controller.dispose()
  })

  it('cancels and joins an active request without submitting it again', async () => {
    const entered = Promise.withResolvers<undefined>()
    const { controller, run } = fixture({ run: (_request, signal) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text' as const, text: 'partial' }
        entered.resolve(undefined)
        if (signal?.aborted === false) await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }, send() {}, end() {}, dispose() {},
    }) })
    await controller.refresh()
    const pending = controller.submit('Test', '', '')
    await entered.promise
    controller.stop()
    expect(await pending).toBe(false)
    expect(controller.interaction.getSnapshot()).toMatchObject({ phase: 'cancelled', frames: [{ type: 'text', text: 'partial' }] })
    expect(run).toHaveBeenCalledTimes(1)
    await controller.dispose()
  })

  it('does not retain a submitted key in browser state', async () => {
    const { controller } = fixture()
    await controller.refresh()
    expect(await controller.save({ ...service(), apiKey: 'private-replacement' })).toBe(true)
    expect(JSON.stringify(controller.catalog.getSnapshot())).not.toContain('private-replacement')
    await controller.dispose()
  })

  it('displays saved results even when the original service was removed', async () => {
    const { controller } = fixture({ services: [] })
    const request: DirectRequest = { serviceId: id, messages: [{ role: 'user', content: 'Previous request' }] }
    const record: RunRecord = { id: 'run-one' as RunRecord['id'], service: service(), request, startedAt: 1, status: 'completed', frames: [{ type: 'text', text: 'Previous answer' }, { type: 'done' }] }
    controller.restore(record)
    await controller.refresh()
    expect(controller.interaction.getSnapshot()).toMatchObject({ serviceId: id, phase: 'completed', frames: record.frames })
    expect(await controller.submit('Must not run', '', '')).toBe(false)
    await controller.dispose()
  })
})
