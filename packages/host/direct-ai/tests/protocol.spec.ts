/** Real HTTP fixtures pin credential routing, bounded parsing and cancellation without provider billing. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { configSchema } from '../src/config.ts'
import { execute, mediaMime, type ProviderCall, type ProviderImage } from '../src/protocol.ts'
import { editEndpointOf, endpointOf, metadata, parameters, requestSchema, safeUrl } from '../src/validation.ts'
import type { Capability, DirectFrame, ServiceId } from '../src/types.ts'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const otherPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const maskPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2])
const mp4 = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109])
const key = 'private-test-key'

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const value = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()) })
  value.listen(0, '127.0.0.1')
  onTestFinished(async () => {
    value.closeAllConnections()
    await new Promise<void>((resolve, reject) => { value.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await once(value, 'listening')
  const address = value.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  return `http://127.0.0.1:${address.port}/v1`
}

function call(baseURL: string, capability: Capability, patch: Partial<ProviderCall> = {}): ProviderCall {
  return { service: { name: 'test', capability, model: 'model', baseURL },
    request: { serviceId: 's-test' as ServiceId, messages: [{ role: 'user', content: 'full input' }] }, key,
    config: configSchema({ pollIntervalMs: 1 }), signal: new AbortController().signal, references: [],
    media: async (value, mime) => ({ url: `media:${value.length}`, mime }), ...patch,
  }
}
async function collect(input: ProviderCall): Promise<DirectFrame[]> {
  const frames: DirectFrame[] = []
  for await (const frame of execute(input)) frames.push(frame)
  return frames
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const value: unknown = chunk
    if (typeof value === 'string') chunks.push(Buffer.from(value))
    else if (Buffer.isBuffer(value)) chunks.push(value)
    else throw new Error('Unexpected HTTP request chunk')
  }
  return Buffer.concat(chunks)
}

interface MultipartPart { header: string; value: Buffer }

function multipart(body: Buffer, contentType: string | undefined): MultipartPart[] {
  const boundary = /boundary=(?:"([^"]+)"|(.+))$/.exec(contentType ?? '')
  const marker = boundary?.[1] ?? boundary?.[2]
  if (marker === undefined) throw new Error('Response did not carry a multipart boundary')
  const separator = Buffer.from(`--${marker}`)
  const parsed: MultipartPart[] = []
  let start = body.indexOf(separator)
  while (start >= 0) {
    const begin = start + separator.length + 2
    const next = body.indexOf(separator, begin)
    if (next < 0) break
    const segment = body.subarray(begin, next - 2)
    const split = segment.indexOf('\r\n\r\n')
    if (split >= 0) parsed.push({ header: segment.subarray(0, split).toString(), value: segment.subarray(split + 4) })
    start = next
  }
  return parsed
}

function field(parts: readonly MultipartPart[], name: string): string | undefined {
  return parts.find(part => part.header.includes(`name="${name}"`))?.value.toString()
}

function uploaded(parts: readonly MultipartPart[], name: string): MultipartPart[] {
  return parts.filter(part => part.header.includes(`name="${name}"`))
}

it.each(['http://example.org/v1', 'https://user:secret@example.org/v1', 'https://example.org/v1?key=secret', 'https://example.org/v1#fragment', 'file:///tmp/a'])(
  'rejects unsafe base URL %s', (url) => { expect(() => safeUrl(url, true)).toThrow() },
)
it.each(['https://evil.example/run', '//evil.example/run', '\\evil', '/v1/run?key=secret', '#fragment'])(
  'rejects endpoint origin, query and fragment overrides %s', (endpoint) => {
    expect(() => endpointOf({ name: 'test', capability: 'chat', model: 'm', baseURL: 'https://example.org/v1', endpoint })).toThrow()
  },
)
it('resolves explicit defaults and accepts loopback HTTP', () => {
  expect(endpointOf(metadata({ name: ' test ', model: ' m ', capability: 'chat', baseURL: 'http://localhost:123/v1' })).href)
    .toBe('http://localhost:123/v1/chat/completions')
  expect(() => metadata({ name: 'test', model: ' ', capability: 'chat', baseURL: 'https://example.org' })).toThrow()
})
it('derives the edit endpoint from the generation path and validates an explicit one', () => {
  const image = metadata({ name: 'test', model: 'model', capability: 'image', baseURL: 'https://example.org/v1' })
  expect(editEndpointOf(image).href).toBe('https://example.org/v1/images/edits')
  expect(editEndpointOf(metadata({ ...image, endpoint: 'custom/generations' })).href).toBe('https://example.org/v1/custom/edits')
  expect(editEndpointOf(metadata({ ...image, endpoint: 'custom/draw' })).href).toBe('https://example.org/v1/images/edits')
  expect(editEndpointOf(metadata({ ...image, editEndpoint: 'custom/edit' })).href).toBe('https://example.org/v1/custom/edit')
  expect(() => metadata({ ...image, editEndpoint: 'https://evil.example/edit' })).toThrow()
  expect(() => metadata({ ...image, editEndpoint: 'edit?key=secret' })).toThrow()
})
it.each(['[]', 'null', '"text"', '{', '{"model":"other"}', '{"tools":[]}', '{"nested":{"tool_choice":"auto"}}', '{"headers":{"authorization":"secret"}}',
  '{"image":"inline"}', '{"mask":"inline"}'])(
  'rejects parameter input %s', (value) => { expect(() => parameters(value)).toThrow() },
)
it('retains ordinary JSON model parameters', () => { expect(parameters('{"temperature":0.3,"size":"1024x1024"}')).toEqual({ temperature: 0.3, size: '1024x1024' }) })

it('streams split SSE, ignores comments, and suppresses key echoes across event boundaries', async () => {
  let payload: unknown
  let authorization: string | undefined
  const origin = await server(async (req, res) => {
    authorization = req.headers.authorization
    const parts: Buffer[] = []
    for await (const part of req) {
      const value: unknown = part
      if (typeof value === 'string') parts.push(Buffer.from(value))
      else if (Buffer.isBuffer(value)) parts.push(value)
      else throw new Error('Unexpected HTTP request chunk')
    }
    payload = JSON.parse(Buffer.concat(parts).toString())
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(': ping\r\ndata: {"choices":[{"delta":{"content":"hello private-"}}]}\r\n\r\n')
    res.write('data: {"choices":[{"delta":{"content":"test-key world"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const frames = await collect(call(origin, 'chat'))
  expect(authorization).toBe(`Bearer ${key}`)
  expect(payload).toEqual({ model: 'model', messages: [{ role: 'user', content: 'full input' }], stream: true })
  expect(frames.filter(frame => frame.type === 'text').map(frame => frame.text).join('')).toBe('hello [redacted] world')
  expect(JSON.stringify(frames)).not.toContain(key)
})

it.each(['data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\n', 'data: {"error":{"message":"private-test-key"}}\n\n', 'data: {"choices":[]}\n\n'])(
  'refuses tool output, error envelopes and truncated SSE', async (body) => {
    const origin = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body) })
    await expect(collect(call(origin, 'chat'))).rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_RESPONSE' })
  },
)
it('rejects multiple chat alternatives instead of interleaving their text', async () => {
  const origin = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"index":0,"delta":{"content":"A"}},{"index":1,"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n')
  })
  await expect(collect(call(origin, 'chat'))).rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_RESPONSE' })
  await expect(collect({ ...call(origin, 'chat'), request: { ...call(origin, 'chat').request, parametersJson: '{"n":2}' } }))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
})

it('refuses key-bearing redirects and never reaches their target', async () => {
  let target = 0
  const origin = await server((req, res) => {
    if (req.url === '/target') { target++; res.end('bad'); return }
    res.writeHead(307, { location: '/target' }); res.end('private-test-key')
  })
  const error = await collect(call(origin, 'chat')).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'DIRECT_AI_HTTP_FAILED' })
  expect(String(error)).not.toContain(key)
  expect(target).toBe(0)
})
it('does not retain or expose provider error bodies and does not retry', async () => {
  let count = 0
  const origin = await server((_req, res) => { count++; res.writeHead(429); res.end(`secret: ${key}`) })
  const error = await collect(call(origin, 'chat')).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'DIRECT_AI_HTTP_FAILED' })
  expect(String(error)).not.toContain(key)
  expect(count).toBe(1)
})
it('bounds an oversized single response chunk', async () => {
  const origin = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('x'.repeat(1000)) })
  await expect(collect(call(origin, 'chat', { config: configSchema({ maxResponseBytes: 10 }) }))).rejects.toMatchObject({ code: 'DIRECT_AI_LIMIT' })
})
it('accepts base64 images and downloads URL images without Authorization', async () => {
  const seen: (string | undefined)[] = []
  let origin = ''
  origin = await server((req, res) => {
    seen.push(req.headers.authorization)
    if (req.url === '/image') { res.end(png); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }, { url: `${origin.replace('/v1', '')}/image` }] }))
  })
  expect(await collect(call(origin, 'image'))).toEqual([
    { type: 'media', url: `media:${png.length}`, mime: 'image/png' },
    { type: 'media', url: `media:${png.length}`, mime: 'image/png' },
  ])
  expect(seen).toEqual([`Bearer ${key}`, undefined])
})
it('prefers inline image bytes when a gateway also retains its upstream URL', async () => {
  let downloads = 0
  const origin = await server((req, res) => {
    if (req.method === 'GET') { downloads += 1; res.end(png); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64'), url: 'https://unused.example/provider-image' }] }))
  })
  expect(await collect(call(origin, 'image'))).toEqual([{ type: 'media', url: `media:${png.length}`, mime: 'image/png' }])
  expect(downloads).toBe(0)
})
it('rejects invalid inline image bytes without falling back to a second fetch', async () => {
  let requests = 0
  const origin = await server((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: 'invalid!', url: 'https://unused.example/provider-image' }] }))
  })
  await expect(collect(call(origin, 'image'))).rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_RESPONSE' })
  expect(requests).toBe(1)
})
it('rejects active inline formats and invalid base64', async () => {
  expect(() => mediaMime(Buffer.from('<svg/>'), 'image')).toThrow()
  const origin = await server((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"b64_json":"a!=="}]}') })
  await expect(collect(call(origin, 'image'))).rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_RESPONSE' })
})

it('submits one reference image as multipart images/edits without a mask', async () => {
  const requests: string[] = []
  let authorization: string | undefined
  let contentType: string | undefined
  let body: Buffer = Buffer.alloc(0)
  const origin = await server(async (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    authorization = req.headers.authorization
    contentType = req.headers['content-type']
    body = await requestBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  const frames = await collect(call(origin, 'image', { references: [{ bytes: png, mime: 'image/png', name: 'first.png' }] }))
  expect(requests).toEqual(['POST /v1/images/edits'])
  expect(authorization).toBe(`Bearer ${key}`)
  expect(contentType).toContain('multipart/form-data; boundary=')
  const form = multipart(body, contentType)
  expect(field(form, 'model')).toBe('model')
  expect(field(form, 'prompt')).toBe('full input')
  const images = uploaded(form, 'image')
  expect(images).toHaveLength(1)
  expect(images[0]?.header).toContain('filename="first.png"')
  expect(images[0]?.header.toLowerCase()).toContain('content-type: image/png')
  expect(images[0]?.value).toEqual(png)
  expect(uploaded(form, 'mask')).toEqual([])
  expect(frames).toEqual([{ type: 'media', url: `media:${png.length}`, mime: 'image/png' }])
})

it('submits multiple reference images in request order', async () => {
  let contentType: string | undefined
  let body: Buffer = Buffer.alloc(0)
  const origin = await server(async (req, res) => {
    contentType = req.headers['content-type']
    body = await requestBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  const references: ProviderImage[] = [{ bytes: png, mime: 'image/png', name: 'first.png' }, { bytes: otherPng, mime: 'image/png' }]
  await collect(call(origin, 'image', { references }))
  const images = uploaded(multipart(body, contentType), 'image')
  expect(images.map(part => /filename="([^"]*)"/.exec(part.header)?.[1])).toEqual(['first.png', 'image-2.png'])
  expect(images.map(part => part.value)).toEqual([png, otherPng])
})

it('appends exactly one mask part when the request carries a mask', async () => {
  let contentType: string | undefined
  let body: Buffer = Buffer.alloc(0)
  const origin = await server(async (req, res) => {
    contentType = req.headers['content-type']
    body = await requestBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await collect(call(origin, 'image', {
    references: [{ bytes: png, mime: 'image/png', name: 'first.png' }],
    mask: { bytes: maskPng, mime: 'image/png', name: 'edit-mask.png' },
  }))
  const form = multipart(body, contentType)
  expect(uploaded(form, 'image')).toHaveLength(1)
  const masks = uploaded(form, 'mask')
  expect(masks).toHaveLength(1)
  expect(masks[0]?.header).toContain('filename="edit-mask.png"')
  expect(masks[0]?.header.toLowerCase()).toContain('content-type: image/png')
  expect(masks[0]?.value).toEqual(maskPng)
})

it('sends admitted parameters as form fields instead of a JSON body', async () => {
  let contentType: string | undefined
  let body: Buffer = Buffer.alloc(0)
  const origin = await server(async (req, res) => {
    contentType = req.headers['content-type']
    body = await requestBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  const input = call(origin, 'image', {
    service: { name: 'test', capability: 'image', model: 'model', baseURL: origin, parametersJson: '{"size":"1024x1024"}' },
    request: { serviceId: 's-test' as ServiceId, messages: [{ role: 'user', content: 'full input' }], parametersJson: '{"quality":"high","n":2}' },
    references: [{ bytes: png, mime: 'image/png' }],
  })
  await collect(input)
  const form = multipart(body, contentType)
  expect(field(form, 'size')).toBe('1024x1024')
  expect(field(form, 'quality')).toBe('high')
  expect(field(form, 'n')).toBe('2')
  expect(contentType).not.toContain('application/json')
  expect(body.toString()).not.toContain('{"quality"')
})

it('bounds the retained display prompt after trimming without making it a provider parameter', () => {
  const messages = [{ role: 'user' as const, content: 'Draw' }]
  expect(requestSchema.parse({ serviceId: 's-test', messages, displayPrompt: `  ${'x'.repeat(4000)}  ` }).displayPrompt)
    .toHaveLength(4000)
  expect(requestSchema.safeParse({ serviceId: 's-test', messages, displayPrompt: 'x'.repeat(4001) }).success).toBe(false)
})

it('never sends the retained display prompt to the provider', async () => {
  const bodies: Buffer[] = []
  const contentTypes: (string | undefined)[] = []
  const origin = await server(async (req, res) => {
    contentTypes.push(req.headers['content-type'])
    bodies.push(await requestBody(req))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  const request = {
    serviceId: 's-test' as ServiceId, messages: [{ role: 'user' as const, content: 'full input' }],
    displayPrompt: 'the description the user typed',
  }
  await collect(call(origin, 'image', { request }))
  expect(JSON.parse(bodies[0]?.toString() ?? '')).toEqual({ model: 'model', prompt: 'full input' })
  await collect(call(origin, 'image', { request, references: [{ bytes: png, mime: 'image/png' }] }))
  const form = multipart(bodies[1] ?? Buffer.alloc(0), contentTypes[1])
  expect(field(form, 'displayPrompt')).toBeUndefined()
  expect(field(form, 'prompt')).toBe('full input')
  expect(bodies.every(body => !body.toString().includes('the description the user typed'))).toBe(true)
})

it('submits image edits to an explicitly configured edit endpoint', async () => {
  const requests: string[] = []
  const origin = await server(async (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    await requestBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  const input = call(origin, 'image', {
    service: { name: 'test', capability: 'image', model: 'model', baseURL: origin, editEndpoint: 'paint/edit' },
    references: [{ bytes: png, mime: 'image/png' }],
  })
  await collect(input)
  expect(requests).toEqual(['POST /v1/paint/edit'])
})

it.each(['chat', 'video'] as const)('rejects reference images on a %s service without dispatch', async (capability) => {
  let requests = 0
  const origin = await server((_req, res) => { requests += 1; res.end() })
  await expect(collect(call(origin, capability, { references: [{ bytes: png, mime: 'image/png' }] })))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  await expect(collect(call(origin, capability, { mask: { bytes: maskPng, mime: 'image/png' } })))
    .rejects.toMatchObject({ code: 'DIRECT_AI_INVALID_INPUT' })
  expect(requests).toBe(0)
})

it('lands inline and downloaded edit results like generation results', async () => {
  const seen: (string | undefined)[] = []
  let origin = ''
  origin = await server((req, res) => {
    seen.push(req.headers.authorization)
    if (req.url === '/image') { res.end(png); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }, { url: `${origin.replace('/v1', '')}/image` }] }))
  })
  const frames = await collect(call(origin, 'image', { references: [{ bytes: otherPng, mime: 'image/png' }] }))
  expect(frames).toEqual([
    { type: 'media', url: `media:${png.length}`, mime: 'image/png' },
    { type: 'media', url: `media:${png.length}`, mime: 'image/png' },
  ])
  expect(seen).toEqual([`Bearer ${key}`, undefined])
})
it('submits multipart video, polls the same id and downloads completed content', async () => {
  const paths: string[] = []
  let submission = ''
  const origin = await server(async (req, res) => {
    paths.push(`${req.method} ${req.url}`)
    if (req.method === 'POST') {
      expect(req.headers['content-type']).toContain('multipart/form-data; boundary=')
      for await (const part of req) submission += String(part)
    }
    if (req.url?.endsWith('/content')) { res.end(mp4); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'video_123', status: req.method === 'POST' ? 'queued' : 'completed', progress: 100 }))
  })
  expect(await collect(call(origin, 'video'))).toEqual([
    { type: 'progress', status: 'queued', progress: 100 }, { type: 'progress', status: 'completed', progress: 100 },
    { type: 'media', url: `media:${mp4.length}`, mime: 'video/mp4' },
  ])
  expect(paths).toEqual(['POST /v1/videos', 'GET /v1/videos/video_123', 'GET /v1/videos/video_123/content'])
  expect(submission).toContain('name="model"\r\n\r\nmodel')
  expect(submission).toContain('name="prompt"\r\n\r\nfull input')
})
it('cancels video polling before any status GET', async () => {
  const controller = new AbortController()
  const requests: string[] = []
  const origin = await server((req, res) => {
    requests.push(req.method!)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"video_1","status":"queued"}')
  })
  const iterator = execute(call(origin, 'video', { signal: controller.signal, config: configSchema({ pollIntervalMs: 60000 }) }))[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toMatchObject({ type: 'progress', status: 'queued' })
  const next = iterator.next()
  controller.abort()
  await expect(next).rejects.toMatchObject({ name: 'AbortError' })
  expect(requests).toEqual(['POST'])
})
