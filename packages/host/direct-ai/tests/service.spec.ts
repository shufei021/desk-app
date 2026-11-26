/** Loader composition pins durable isolation, executor authorization and teardown through real services. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import DirectAi from '../src/index.ts'
import type { Config } from '../src/config.ts'
import type { DirectFrame, ServiceId, ServiceInput } from '../src/types.ts'

// A non-owner principal exists even when the optional sharing plugin is absent.
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { directAiTestGuest: { readonly kind: 'direct-ai-test-guest' } }
}

async function composed(config: Partial<Config> = {}, attachments = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-ai-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-direct-ai-')) throw new Error('Unexpected fixture cleanup path')
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'cordis.yml')
  const rows = [
    { name: 'cordis:storage' }, { name: 'cordis:json', config: { root: join(root, 'storage') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:credentials', config: { path: join(root, 'credentials.yaml'), watch: false } },
    ...attachments ? [{ name: 'cordis:attachments', config: { dshHome: root } }] : [],
    { name: 'cordis:connection' }, { name: 'cordis:direct', config: { dshHome: root, ...config } },
  ]
  await writeFile(path, rows.map(row => `- ${JSON.stringify(row)}`).join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, storage: Storage, json: Json, domain: Domain, credentials: LocalCredentials,
    connection: Connection, direct: DirectAi, attachments: LocalAttachments,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  const invocation: RemoteInvocation = { request: { namespace: 'directAi', method: 'test', args: {} }, service: 'directAi',
    peer, signal: peer.signal, async *uplink() {},
  }
  const owner = ctx.extend({ invocation }).directAi
  // Await real initialization without manufacturing an invocation-less privileged path.
  await owner.catalog()
  return { ctx, root, owner, invocation }
}

async function provider(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()) })
  server.listen(0, '127.0.0.1')
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  return `http://127.0.0.1:${address.port}/v1`
}
interface ProviderRequest { provider: string; authorization: string | undefined }
function recordProvider(requests: ProviderRequest[], provider: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    requests.push({ provider, authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  }
}
const input = (baseURL: string): ServiceInput => ({ name: 'My service', capability: 'chat', model: 'model', baseURL, apiKey: 'private-test-key' })
async function frames(
  owner: DirectAi, id: ServiceId, signal = new AbortController().signal, references?: ImageAttachmentRef[],
  displayPrompt?: string,
): Promise<DirectFrame[]> {
  const value: DirectFrame[] = []
  for await (const frame of owner.run({ serviceId: id, messages: [{ role: 'user', content: 'my complete private input' }],
    ...references === undefined ? {} : { references },
    ...displayPrompt === undefined ? {} : { displayPrompt },
  }, signal)) value.push(frame)
  return value
}

it('starts empty, stores keys only in credentials, and restores complete successful history', async () => {
  const { root, owner } = await composed()
  expect(await owner.history()).toEqual([])
  const origin = await provider((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n') })
  const service = await owner.save(input(origin))
  expect(service.configured).toBe(true)
  expect(service).not.toHaveProperty('apiKey')
  expect(await frames(owner, service.id)).toEqual([{ type: 'text', text: 'hello' }, { type: 'done' }])
  const history = await owner.history()
  expect(history[0]).toMatchObject({ status: 'completed', request: { messages: [{ role: 'user', content: 'my complete private input' }] }, frames: [{ type: 'text', text: 'hello' }, { type: 'done' }] })
  const serviceFiles = await readdir(join(root, 'storage', 'direct_ai', 'services'))
  expect(serviceFiles).toHaveLength(1)
  expect(await readFile(join(root, 'storage', 'direct_ai', 'services', serviceFiles[0]!), 'utf8')).not.toContain('private-test-key')
  expect(await readFile(join(root, 'credentials.yaml'), 'utf8')).toContain('private-test-key')
  await owner.save({ ...input(origin), id: service.id, apiKey: '' })
  expect((await owner.catalog())[0]?.configured).toBe(false)
  await expect(frames(owner, service.id)).rejects.toMatchObject({ code: 'DIRECT_AI_NOT_CONFIGURED' })
  expect((await owner.history())[0]).toMatchObject({ status: 'failed', error: { code: 'DIRECT_AI_NOT_CONFIGURED' } })
})

it('checks every executor for absent and non-owner invocation, irrespective of global grants', async () => {
  const { ctx, invocation } = await composed()
  const peer = ctx.connection.createPeer({ principal: { kind: 'direct-ai-test-guest' } })
  for (const subject of [ctx.directAi, ctx.extend({ invocation: { ...invocation, peer } }).directAi]) {
    await expect(subject.catalog()).rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
    await expect(subject.save(input('https://example.org/v1'))).rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
    await expect(subject.removeService('s-test' as ServiceId)).rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
    await expect(subject.history()).rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
    await expect(subject.discoverModels({ kind: 'aiyoyoo-public' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
    await expect(subject.uploadReference({ data: 'AAAA', mime: 'image/png' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
    await expect(frames(subject, 's-test' as ServiceId)).rejects.toMatchObject({ code: 'DIRECT_AI_FORBIDDEN' })
  }
})

it('reads model identifiers with a saved credential and retains only display annotations', async () => {
  const { owner } = await composed()
  const authorization: Array<string | undefined> = []
  const origin = await provider((request, response) => {
    authorization.push(request.headers.authorization)
    expect(request.method).toBe('GET')
    expect(request.url).toBe('/v1/models')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-test', owned_by: 'anthropic' }] }))
  })
  const service = await owner.save({ ...input(origin), platform: 'anthropic', groupId: 79, groupName: 'Gemini | 稳定组| Cursor' })
  const directory = await owner.discoverModels({ kind: 'saved', serviceId: service.id }, new AbortController().signal)
  expect(directory.models).toEqual([{ id: 'claude-test', platform: 'anthropic' }])
  expect(authorization).toEqual(['Bearer private-test-key'])
  expect(await owner.catalog()).toEqual([service])
  expect(service).toMatchObject({ platform: 'anthropic', groupId: 79, groupName: 'Gemini | 稳定组| Cursor' })
  expect(await owner.history()).toEqual([])
  const redirected = { kind: 'saved' as const, serviceId: service.id, baseURL: 'https://wrong.example' }
  await expect(owner.discoverModels(redirected, new AbortController().signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  expect(authorization).toHaveLength(1)
})

it('retains cancellation, frees capacity, and does not submit a duplicate request', async () => {
  const { owner } = await composed({ maxConcurrent: 1 })
  let count = 0
  const received = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  const origin = await provider((req, res) => {
    count++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    req.on('close', () =>{  closed.resolve(undefined) })
    received.resolve(undefined)
  })
  const service = await owner.save(input(origin))
  const controller = new AbortController()
  const running = frames(owner, service.id, controller.signal)
  await received.promise
  await expect(frames(owner, service.id)).rejects.toMatchObject({ code: 'DIRECT_AI_BUSY' })
  controller.abort()
  await expect(running).rejects.toMatchObject({ code: 'DIRECT_AI_CANCELLED' })
  await closed.promise
  expect(count).toBe(1)
  expect((await owner.history())[0]).toMatchObject({ status: 'cancelled', error: { code: 'DIRECT_AI_CANCELLED' } })
})

it('serves private media through the exact owner-only route and withdraws it on disposal', async () => {
  const { ctx, owner, invocation } = await composed()
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  const origin = await provider((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })) })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const result = await frames(owner, service.id)
  const frame = result.find(value => value.type === 'media')
  if (frame?.type !== 'media') throw new Error('Media was not published')
  expect(frame.url).toMatch(/^api\/direct-ai\/media\?id=/)
  const fetcher = ctx.connection.createSharedFetchHandler('/api')
  const url = `http://host/${frame.url}`
  const response = await fetcher.fetch(new Request(url), invocation.peer)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  const ranged = await fetcher.fetch(new Request(url, { headers: { range: 'bytes=0-3' } }), invocation.peer)
  expect(ranged.status).toBe(206)
  expect(ranged.headers.get('content-range')).toBe('bytes 0-3/9')
  expect(Buffer.from(await ranged.arrayBuffer())).toEqual(png.subarray(0, 4))
  expect((await fetcher.fetch(new Request(url, { headers: { range: 'bytes=0-1,4-5' } }), invocation.peer)).status).toBe(416)
  expect((await fetcher.fetch(new Request(`${url}&download=1`, { method: 'HEAD' }), invocation.peer)).headers.get('content-disposition')).toContain('attachment')
  const guest = ctx.connection.createPeer({ principal: { kind: 'direct-ai-test-guest' } })
  expect((await fetcher.fetch(new Request(url), guest)).status).toBe(403)
  expect((await fetcher.fetch(new Request('http://host/api/direct-ai/media?id=../../credentials.yaml'), invocation.peer)).status).toBe(404)
  const entry = [...ctx.loader.entries()].find(row => row.options.name === 'cordis:direct')
  await entry!.fiber!.dispose()
  expect((await fetcher.fetch(new Request(url), invocation.peer)).status).toBe(404)
})

it('keeps each provider URL paired with its credential while the owner updates a service', async () => {
  const { ctx, owner } = await composed()
  const requests: ProviderRequest[] = []
  const oldURL = await provider(recordProvider(requests, 'old'))
  const newURL = await provider(recordProvider(requests, 'new'))
  const service = await owner.save({ ...input(oldURL), apiKey: 'old-provider-key' })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  // Queue identity only places the race: an unlocked run must finish save before its credential read can resume.
  const idleQueue: unknown = Reflect.get(owner, 'writes')
  const readRecord = ctx.credentials.readRecord.bind(ctx.credentials)
  let barrierUsed = false
  const readSpy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async (key) => {
    if (!barrierUsed) {
      barrierUsed = true
      entered.resolve(undefined)
      await release.promise
    }
    return readRecord(key)
  })
  let running: Promise<DirectFrame[]> | undefined
  let saving: Promise<unknown> | undefined
  try {
    running = frames(owner, service.id)
    await entered.promise
    const runOwnsQueue = Reflect.get(owner, 'writes') !== idleQueue
    saving = owner.save({ ...input(newURL), id: service.id, apiKey: 'new-provider-key' })
    if (!runOwnsQueue) await saving
    release.resolve(undefined)
    await Promise.all([running, saving])
    await frames(owner, service.id)
    expect(requests).toEqual([
      { provider: 'old', authorization: 'Bearer old-provider-key' },
      { provider: 'new', authorization: 'Bearer new-provider-key' },
    ])
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([running, saving])
    readSpy.mockRestore()
  }
})

it.each(['credential', 'metadata'] as const)(
  'keeps the committed provider URL and key when the %s write fails during save', async (failurePoint) => {
    const { ctx, owner } = await composed()
    const requests: ProviderRequest[] = []
    const oldURL = await provider(recordProvider(requests, 'old'))
    const newURL = await provider(recordProvider(requests, 'new'))
    const service = await owner.save({ ...input(oldURL), apiKey: 'old-provider-key' })
    const domain = ctx.storageDomain.get('direct_ai')
    if (domain === undefined) throw new Error('Direct AI domain was not opened')
    const services = domain.table('services')
    const committed = services.get(service.id)
    const storageError = new Error('Injected storage failure')
    const spy = failurePoint === 'credential'
      ? vi.spyOn(ctx.credentials, 'modifyRecord').mockRejectedValueOnce(storageError)
      : vi.spyOn(services, 'put').mockRejectedValueOnce(storageError)
    try {
      await expect(owner.save({ ...input(newURL), id: service.id, apiKey: 'new-provider-key' }))
        .rejects.toMatchObject({ code: 'DIRECT_AI_STORAGE_FAILED' })
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
    expect(services.get(service.id)).toEqual(committed)
    expect(await owner.catalog()).toEqual([service])
    await expect(frames(owner, service.id)).resolves.toEqual([{ type: 'done' }])
    expect(requests).toEqual([{ provider: 'old', authorization: 'Bearer old-provider-key' }])
  },
)

it('evicts settled history only after the configured retention limit', async () => {
  const { owner } = await composed({ maxHistory: 1 })
  const origin = await provider((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n') })
  const service = await owner.save(input(origin))
  await frames(owner, service.id)
  await frames(owner, service.id)
  expect(await owner.history()).toHaveLength(1)
})

const generatedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')

it('generates images for a trusted Host consumer without a Remote invocation and keeps attachments after direct pruning', async () => {
  const { ctx, owner } = await composed({ maxHistory: 1 }, true)
  const requests: string[] = []
  const origin = await provider(async (request, response) => {
    expect(request.url).toBe('/v1/images/generations')
    expect(request.headers.authorization).toBe('Bearer private-test-key')
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: generatedPng.toString('base64'), url: 'https://unused.example/image.png' }] }))
  })
  const service = await owner.save({ ...input(origin), capability: 'image', model: 'gpt-image-2' })
  const result = await ctx.directAi.generateImage(service.id, 'First complete image prompt', new AbortController().signal)
  expect(result).toMatchObject({ service: { id: service.id, name: service.name, model: 'gpt-image-2' }, images: [{ mediaType: 'image/png', width: 1, height: 1 }] })
  const [first] = await owner.history()
  expect(first).toMatchObject({ id: result.runId, status: 'completed', request: { messages: [{ role: 'user', content: 'First complete image prompt' }] } })
  const image = result.images[0]!
  expect((await ctx.attachments.readImage(image)).ref.attachmentId).toBe(image.attachmentId)
  await ctx.directAi.generateImage(service.id, 'Second prompt', new AbortController().signal)
  expect(await owner.history()).toHaveLength(1)
  expect((await owner.history())[0]?.id).not.toBe(result.runId)
  expect((await ctx.attachments.readImage(image)).ref.attachmentId).toBe(image.attachmentId)
  expect(requests.map((value): unknown => JSON.parse(value))).toEqual([
    { model: 'gpt-image-2', prompt: 'First complete image prompt' }, { model: 'gpt-image-2', prompt: 'Second prompt' },
  ])
  expect(JSON.stringify(result)).not.toContain('private-test-key')
  expect(JSON.stringify(first)).not.toContain('private-test-key')
})

it('rejects a missing image store, missing image service, a chat service and a keyless service without HTTP dispatch', async () => {
  const missing = await composed()
  await expect(missing.ctx.directAi.generateImage('s-00000000-0000-4000-8000-000000000000' as ServiceId, 'Draw', new AbortController().signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_NOT_CONFIGURED' })
  const { ctx, owner } = await composed({}, true)
  let requests = 0
  const origin = await provider((_request, response) => { requests += 1; response.end() })
  const chat = await owner.save(input(origin))
  const image = await owner.save({ ...input(origin), capability: 'image', apiKey: '' })
  await expect(ctx.directAi.generateImage('s-00000000-0000-4000-8000-000000000000' as ServiceId, 'Draw', new AbortController().signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_NOT_FOUND' })
  await expect(ctx.directAi.generateImage(chat.id, 'Draw', new AbortController().signal)).rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(ctx.directAi.generateImage(image.id, 'Draw', new AbortController().signal)).rejects.toMatchObject({ code: 'DIRECT_AI_NOT_CONFIGURED' })
  expect(requests).toBe(0)
  expect(await owner.history()).toEqual([])
})

it('cancels a trusted image request, joins HTTP cleanup and shares the existing concurrent limit', async () => {
  const { ctx, owner } = await composed({ maxConcurrent: 1 }, true)
  const received = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  let requests = 0
  const origin = await provider((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"data":[')
    response.on('close', () => { closed.resolve(undefined) })
    received.resolve(undefined)
  })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const controller = new AbortController()
  const running = ctx.directAi.generateImage(service.id, 'Draw once', controller.signal)
  await received.promise
  await expect(ctx.directAi.generateImage(service.id, 'Do not dispatch', new AbortController().signal)).rejects.toMatchObject({ code: 'DIRECT_AI_BUSY' })
  controller.abort()
  await expect(running).rejects.toMatchObject({ code: 'DIRECT_AI_CANCELLED' })
  await closed.promise
  expect(requests).toBe(1)
  expect((await owner.history())[0]).toMatchObject({ status: 'cancelled' })
  const already = AbortSignal.abort()
  await expect(ctx.directAi.generateImage(service.id, 'Already stopped', already)).rejects.toMatchObject({ code: 'DIRECT_AI_CANCELLED' })
  expect(requests).toBe(1)
})

it('settles attachment-storage failure without revealing its diagnostic or retrying a paid request', async () => {
  const { ctx, owner } = await composed({}, true)
  let requests = 0
  const origin = await provider((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: generatedPng.toString('base64') }] }))
  })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const spy = vi.spyOn(ctx.attachments, 'saveImage').mockRejectedValueOnce(new Error('private-test-key private storage diagnostic'))
  try {
    await expect(ctx.directAi.generateImage(service.id, 'Draw', new AbortController().signal)).rejects.toMatchObject({ code: 'DIRECT_AI_STORAGE_FAILED' })
  } finally { spy.mockRestore() }
  const history = await owner.history()
  expect(history[0]).toMatchObject({ status: 'failed', error: { code: 'DIRECT_AI_STORAGE_FAILED' } })
  expect(JSON.stringify(history)).not.toContain('private-test-key')
  expect(requests).toBe(1)
})

it('drains a non-cancellable image attachment write before plugin disposal releases the domain', async () => {
  const { ctx, owner } = await composed({}, true)
  const origin = await provider((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: generatedPng.toString('base64') }] }))
  })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = ctx.attachments.saveImage.bind(ctx.attachments)
  const spy = vi.spyOn(ctx.attachments, 'saveImage').mockImplementation(async (image) => {
    entered.resolve(undefined)
    await release.promise
    return original(image)
  })
  const running = ctx.directAi.generateImage(service.id, 'Draw', new AbortController().signal)
  const outcome = running.catch((error: unknown) => error)
  await entered.promise
  const entry = [...ctx.loader.entries()].find(row => row.options.name === 'cordis:direct')
  let disposed = false
  const closing = entry!.fiber!.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  try {
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'DIRECT_AI_CANCELLED' })
    await closing
    expect(disposed).toBe(true)
  } finally { release.resolve(undefined); await Promise.allSettled([running, closing]); spy.mockRestore() }
})

it('stores a reference image and returns its durable attachment reference', async () => {
  const { ctx, owner } = await composed({}, true)
  const data = generatedPng.toString('base64')
  const reference = await owner.uploadReference({ data, mime: 'image/png', name: 'reference.png' }, new AbortController().signal)
  expect(reference).toMatchObject({ mediaType: 'image/png', width: 1, height: 1, name: 'reference.png' })
  const stored = await ctx.attachments.readImage(reference)
  expect(stored.ref).toEqual(reference)
  expect(stored.data.byteLength).toBe(reference.bytes)
  expect(Buffer.from(stored.data).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(await owner.history()).toEqual([])
})

it('refuses non-canonical, foreign, empty and unstorable reference uploads', async () => {
  const { owner } = await composed({}, true)
  const missing = await composed()
  const data = generatedPng.toString('base64')
  const signal = new AbortController().signal
  await expect(owner.uploadReference({ data: `${data}!`, mime: 'image/png' }, signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(owner.uploadReference({ data: data.slice(0, -2), mime: 'image/png' }, signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(owner.uploadReference({ data: 'aGVsbG8', mime: 'image/png' }, signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(owner.uploadReference({ data: '', mime: 'image/png' }, signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(owner.uploadReference({ data, mime: 'image/svg+xml' }, signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(missing.owner.uploadReference({ data, mime: 'image/png' }, signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_NOT_CONFIGURED' })
  expect(await owner.history()).toEqual([])
})

it('accepts a reference upload at the configured byte limit and refuses a larger one', async () => {
  const data = generatedPng.toString('base64')
  const exact = await composed({ maxMediaBytes: generatedPng.byteLength }, true)
  await expect(exact.owner.uploadReference({ data, mime: 'image/png' }, new AbortController().signal))
    .resolves.toMatchObject({ mediaType: 'image/png' })
  const small = await composed({ maxMediaBytes: generatedPng.byteLength - 1 }, true)
  await expect(small.owner.uploadReference({ data, mime: 'image/png' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'DIRECT_AI_LIMIT' })
})

it('submits stored references through images/edits and retains only their references', async () => {
  const { owner } = await composed({}, true)
  const seen: { url: string | undefined; contentType: string | undefined; authorization: string | undefined; body: Buffer }[] = []
  const origin = await provider(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    seen.push({ url: request.url, contentType: request.headers['content-type'], authorization: request.headers.authorization,
      body: Buffer.concat(chunks) })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: generatedPng.toString('base64') }] }))
  })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  expect(service).not.toHaveProperty('editEndpoint')
  await expect(owner.save({ ...input(origin), capability: 'image', editEndpoint: 'https://evil.example/edit' }))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  const reference = await owner.uploadReference(
    { data: generatedPng.toString('base64'), mime: 'image/png', name: 'reference.png' }, new AbortController().signal,
  )
  const result = await frames(owner, service.id, new AbortController().signal, [reference])
  expect(result).toMatchObject([{ type: 'media', mime: 'image/png' }, { type: 'done' }])
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ url: '/v1/images/edits', authorization: 'Bearer private-test-key' })
  expect(seen[0]?.contentType).toContain('multipart/form-data; boundary=')
  expect(seen[0]?.body.toString('latin1')).toContain('filename="reference.png"')
  const [record] = await owner.history()
  expect(record).toMatchObject({ status: 'completed', request: { references: [reference] } })
  expect(JSON.stringify(record)).not.toContain(generatedPng.toString('base64'))
  const updated = await owner.save({ ...input(origin), id: service.id, capability: 'image', editEndpoint: 'paint/edit' })
  expect(updated.editEndpoint).toBe('paint/edit')
  expect((await owner.catalog())[0]?.editEndpoint).toBe('paint/edit')
})

it('rejects unavailable or tampered reference images without dispatching HTTP', async () => {
  const { owner } = await composed({}, true)
  let requests = 0
  const origin = await provider((_request, response) => { requests += 1; response.end() })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const reference = await owner.uploadReference(
    { data: generatedPng.toString('base64'), mime: 'image/png' }, new AbortController().signal,
  )
  const missing: ImageAttachmentRef = {
    ...reference, attachmentId: `sha256:${'0'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
  }
  await expect(frames(owner, service.id, new AbortController().signal, [missing]))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(frames(owner, service.id, new AbortController().signal, [{ ...reference, width: reference.width + 1 }]))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  expect(requests).toBe(0)
  const history = await owner.history()
  expect(history[0]).toMatchObject({ status: 'failed', error: { code: 'DIRECT_AI_INVALID_INPUT' } })
  expect(history[0]?.frames).toEqual([])
})

it('retains the display prompt with the request while sending only the messages to the provider', async () => {
  const { owner } = await composed({}, true)
  const bodies: string[] = []
  const origin = await provider(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    bodies.push(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: generatedPng.toString('base64') }] }))
  })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const result = await frames(owner, service.id, new AbortController().signal, undefined, '  The typed description  ')
  expect(result).toMatchObject([{ type: 'media', mime: 'image/png' }, { type: 'done' }])
  expect(JSON.parse(bodies[0] ?? '')).toEqual({ model: 'model', prompt: 'my complete private input' })
  expect(bodies[0]).not.toContain('The typed description')
  expect((await owner.history())[0]).toMatchObject({
    status: 'completed', request: { displayPrompt: 'The typed description' },
  })
})

it('rejects an over-long display prompt without dispatch or a retained run', async () => {
  const { owner } = await composed({}, true)
  let requests = 0
  const origin = await provider((_request, response) => { requests += 1; response.end() })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  await expect(frames(owner, service.id, new AbortController().signal, undefined, 'x'.repeat(4001)))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  expect(requests).toBe(0)
  expect(await owner.history()).toEqual([])
})

it('settles a cancelled reference-image edit as cancelled without retrying', async () => {  const { owner } = await composed({}, true)
  const received = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  let requests = 0
  const origin = await provider((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"data":[')
    response.on('close', () => { closed.resolve(undefined) })
    received.resolve(undefined)
  })
  const service = await owner.save({ ...input(origin), capability: 'image' })
  const reference = await owner.uploadReference(
    { data: generatedPng.toString('base64'), mime: 'image/png' }, new AbortController().signal,
  )
  const controller = new AbortController()
  const running = frames(owner, service.id, controller.signal, [reference])
  await received.promise
  controller.abort()
  await expect(running).rejects.toMatchObject({ code: 'DIRECT_AI_CANCELLED' })
  await closed.promise
  expect(requests).toBe(1)
  expect((await owner.history())[0]).toMatchObject({ status: 'cancelled', error: { code: 'DIRECT_AI_CANCELLED' }, request: { references: [reference] } })
})
