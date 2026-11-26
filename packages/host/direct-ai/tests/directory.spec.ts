/** Catalog fixtures exercise real loopback HTTP and intercept only the fixed public endpoint. */
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { configSchema, type Config } from '../src/config.ts'
import { readDirectory } from '../src/directory.ts'
import { DirectAiError } from '../src/error.ts'

const publicUrl = 'https://www.aiyoyoo.com/api/v1/llm-pricing/models'
const key = 'directory-private-test-key'
// Reduced public response: the group title does not determine its platform or model capability.
const publicFixture = {
  code: 0, message: 'success',
  data: { description: '', groups: [
    { id: 27, name: 'GPT | 超级福利组 | 高峰期不稳',
      description: '【可视情况蹬】该分组高峰期可能不稳，且随时可能拉闸，尽力维护，如不可用，可换GPT其他分组', platform: 'openai',
      models: [{ name: 'gpt-5.5', platform: 'openai', pricing: { billing_mode: 'token', input_price: 0.000005, output_price: 0.00003 } }],
    },
    { id: 79, name: 'Gemini | 稳定组 | Cursor', description: 'Cursor反代，目前比较稳定', platform: 'anthropic',
      models: [{ name: 'claude-fable-5', platform: 'anthropic', pricing: { billing_mode: 'token', input_price: 0.00001, output_price: 0.00005 } }],
    },
  ] },
}

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const value = createServer(handler)
  onTestFinished(async () => {
    value.closeAllConnections()
    await new Promise<void>((resolve, reject) => { value.close((error) => { if (error) reject(error); else resolve() }) })
  })
  value.listen(0, '127.0.0.1')
  await once(value, 'listening')
  const address = value.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind TCP')
  return `http://127.0.0.1:${address.port}/v1`
}

function provider(baseURL: string, patch: Partial<Config> = {}, signal = new AbortController().signal, apiKey: string | undefined = key) {
  return readDirectory('provider', baseURL, apiKey, signal, configSchema(patch))
}

async function withPublic<T>(
  factory: (init: RequestInit | undefined) => Response | Promise<Response>, action: () => Promise<T>,
): Promise<T> {
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!(input instanceof URL) || input.href !== publicUrl) throw new Error('Unexpected public catalog URL')
    return factory(init)
  })
  onTestFinished(() => { mock.mockRestore() })
  try {
    const result = await action()
    expect(mock).toHaveBeenCalledTimes(1)
    return result
  } finally { mock.mockRestore() }
}

function publicDirectory(raw: unknown, patch: Partial<Config> = {}, apiKey: string | undefined = key) {
  return withPublic(() => Response.json(raw), () =>
    readDirectory('aiyoyoo-public', 'https://user:ignored@unrelated.example/path?key=ignored#ignored', apiKey,
      new AbortController().signal, configSchema(patch)))
}

async function failure(operation: Promise<unknown>, code: string): Promise<DirectAiError> {
  const result: unknown = await operation.catch((error: unknown) => error)
  expect(result).toBeInstanceOf(DirectAiError)
  expect(result).toMatchObject({ name: 'DirectAiError', code })
  if (!(result instanceof DirectAiError)) throw new Error('Expected a typed direct-AI failure')
  expect(String(result)).not.toContain(key)
  expect(JSON.stringify(result)).not.toContain(key)
  return result
}

it('reads real public response fields without credentials, pricing or inferred capabilities', async () => {
  const before = Date.now()
  const directory = await withPublic((init) => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
    expect(init?.body).toBeUndefined()
    return Response.json(publicFixture)
  }, () => readDirectory('aiyoyoo-public', 'not even a URL', key, new AbortController().signal, configSchema({})))
  expect(directory).toEqual({ source: 'aiyoyoo-public', fetchedAt: directory.fetchedAt,
    groups: [
      { id: 27, name: 'GPT | 超级福利组 | 高峰期不稳', platform: 'openai',
        description: '【可视情况蹬】该分组高峰期可能不稳，且随时可能拉闸，尽力维护，如不可用，可换GPT其他分组' },
      { id: 79, name: 'Gemini | 稳定组 | Cursor', platform: 'anthropic', description: 'Cursor反代，目前比较稳定' },
    ],
    models: [
      { id: 'gpt-5.5', platform: 'openai', groupId: 27, groupName: 'GPT | 超级福利组 | 高峰期不稳' },
      { id: 'claude-fable-5', platform: 'anthropic', groupId: 79, groupName: 'Gemini | 稳定组 | Cursor' },
    ],
  })
  expect(directory.fetchedAt).toBeGreaterThanOrEqual(before)
  expect(directory.fetchedAt).toBeLessThanOrEqual(Date.now())
  expect(JSON.stringify(directory)).not.toContain(key)
})

it.each(['/v1', '/v1/'])('reads standard provider models under base %s with one Bearer GET', async (suffix) => {
  const seen: { path: string | undefined; method: string | undefined; authorization: string | undefined; accept: string | undefined }[] = []
  const base = await server((req, res) => {
    seen.push({ path: req.url, method: req.method, authorization: req.headers.authorization, accept: req.headers.accept })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'gpt-image-1', owned_by: 'literal-owner', created: 123, capability: 'chat' },
      { id: 'video-chat-looking-id' },
    ], extra: key }))
  })
  const directory = await provider(`${new URL(base).origin}${suffix}`)
  expect(directory.fetchedAt).toBeTypeOf('number')
  expect(directory).toEqual({ source: 'provider', fetchedAt: directory.fetchedAt, groups: [], models: [
    { id: 'gpt-image-1', platform: 'literal-owner' }, { id: 'video-chat-looking-id', platform: 'unknown' },
  ] })
  expect(seen).toEqual([{ path: '/v1/models', method: 'GET', authorization: `Bearer ${key}`, accept: 'application/json' }])
})

it('allows an empty provider catalog and ignores extra response fields', async () => {
  const base = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[],"extra":{"untrusted":true}}')
  })
  expect(await provider(base)).toMatchObject({ source: 'provider', models: [], groups: [] })
  expect(await publicDirectory({ code: 0, data: { groups: [] } }, {}, undefined)).toMatchObject({ models: [], groups: [] })
})

it.each([
  'not a URL', 'http://example.org/v1', 'ftp://example.org/v1',
  'https://user:password@example.org/v1', 'https://example.org/v1?key=private', 'https://example.org/v1#fragment',
])('rejects unsafe provider base URL without fetching %s', async (base) => {
  const mock = vi.spyOn(globalThis, 'fetch')
  onTestFinished(() => { mock.mockRestore() })
  try {
    await failure(provider(base), 'DIRECT_AI_INVALID_INPUT')
    expect(mock).not.toHaveBeenCalled()
  } finally { mock.mockRestore() }
})

it.each([undefined, ''])('requires a provider credential before fetching (%s)', async (apiKey) => {
  const mock = vi.spyOn(globalThis, 'fetch')
  onTestFinished(() => { mock.mockRestore() })
  try {
    await failure(readDirectory('provider', 'https://example.org/v1', apiKey, new AbortController().signal, configSchema({})), 'DIRECT_AI_NOT_CONFIGURED')
    expect(mock).not.toHaveBeenCalled()
  } finally { mock.mockRestore() }
})

it('bounds the complete request URL and headers before HTTP', async () => {
  let requests = 0
  const base = await server((_req, res) => { requests++; res.end() })
  await failure(provider(base, { maxRequestBytes: 1 }), 'DIRECT_AI_LIMIT')
  expect(requests).toBe(0)
})

it.each([301, 302, 307, 308])('refuses HTTP %i redirects without reaching their target or retrying', async (status) => {
  const paths: string[] = []
  const base = await server((req, res) => {
    paths.push(req.url ?? '')
    if (req.url === '/target') { res.end('unexpected'); return }
    res.writeHead(status, { location: '/target' }); res.end(key)
  })
  await failure(provider(base), 'DIRECT_AI_HTTP_FAILED')
  expect(paths).toEqual(['/v1/models'])
})

it.each([400, 401, 429, 500, 503])('reports HTTP %i without body, key, status text or retry', async (status) => {
  let requests = 0
  const base = await server((_req, res) => {
    requests++
    res.writeHead(status, key, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: `echo ${key}` }))
  })
  const error = await failure(provider(base), 'DIRECT_AI_HTTP_FAILED')
  expect(error.message).toContain(`HTTP ${status}`)
  expect(error.message).not.toContain('echo')
  expect(requests).toBe(1)
})

it('converts a disconnected HTTP response without exposing transport details or retrying', async () => {
  let requests = 0
  const base = await server((_req, res) => { requests++; res.destroy(new Error(key)) })
  await failure(provider(base), 'DIRECT_AI_HTTP_FAILED')
  expect(requests).toBe(1)
})

it.each([
  ['{', 'application/json'], ['null', 'application/json'], ['{"data":[]}', 'text/plain'],
  ['{"data":[]}', undefined], ['{"data":[{"id":""}]}', 'application/json'],
  ['{"data":[{"id":"  "}]}', 'application/json'], ['{"data":[{"id":1}]}', 'application/json'],
  ['{"data":[{"id":"a","owned_by":null}]}', 'application/json'],
  ['{"data":[{"id":"a","owned_by":""}]}', 'application/json'],
  ['{"data":[],"object":5}', 'application/json'], ['{"models":[]}', 'application/json'],
])('rejects invalid provider JSON or content type (%s, %s)', async (body, type) => {
  let requests = 0
  const base = await server((_req, res) => {
    requests++; res.writeHead(200, type === undefined ? {} : { 'content-type': type }); res.end(body)
  })
  await failure(provider(base), 'DIRECT_AI_INVALID_RESPONSE')
  expect(requests).toBe(1)
})

it('rejects malformed UTF-8 even when JSON could otherwise be decoded', async () => {
  const base = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(Buffer.concat([Buffer.from('{"data":[{"id":"'), Buffer.from([255]), Buffer.from('"}]}')]))
  })
  await failure(provider(base), 'DIRECT_AI_INVALID_RESPONSE')
})

it.each([
  { code: 1, data: { groups: [] } }, { code: 0, data: {} }, { code: 0, data: { groups: [null] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], id: -1 }] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], id: 1.5 }] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], id: '1' }] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], name: '' }] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], description: null }] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], models: [{ name: '', platform: 'p' }] }] } },
  { code: 0, data: { groups: [{ ...publicFixture.data.groups[0], models: [{ name: 'a', platform: 3 }] }] } },
])('rejects invalid public fields %#', async (raw) => {
  await failure(publicDirectory(raw), 'DIRECT_AI_INVALID_RESPONSE')
})

it('retains the same model identifier once for every distinct public group', async () => {
  const first = publicFixture.data.groups[0]!
  const directory = await publicDirectory({ code: 0, data: { groups: [first, { ...first, id: 28, name: 'Second group' }] } })
  expect(directory.models).toEqual([
    { id: 'gpt-5.5', platform: 'openai', groupId: 27, groupName: first.name },
    { id: 'gpt-5.5', platform: 'openai', groupId: 28, groupName: 'Second group' },
  ])
})

it('rejects duplicate provider ids rather than returning ambiguous keys', async () => {
  const base = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"same"},{"id":"same","owned_by":"different"}]}')
  })
  await failure(provider(base), 'DIRECT_AI_INVALID_RESPONSE')
})

it('rejects duplicate group ids and duplicate model ids within a public group', async () => {
  const first = publicFixture.data.groups[0]!
  await failure(publicDirectory({ code: 0, data: { groups: [first, { ...first, name: 'Different name' }] } }), 'DIRECT_AI_INVALID_RESPONSE')
  await failure(publicDirectory({ code: 0, data: { groups: [{ ...first, models: [first.models[0], first.models[0]] }] } }), 'DIRECT_AI_INVALID_RESPONSE')
})

it.each(['id', 'owned_by'])('rejects an entire provider response when %s echoes the credential', async (field) => {
  const base = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'safe-model' }, { id: 'other', [field]: `prefix-${key}-suffix` }] }))
  })
  await failure(provider(base), 'DIRECT_AI_INVALID_RESPONSE')
})

it.each(['name', 'platform', 'description', 'model-name', 'model-platform'])(
  'rejects a public %s field containing the supplied credential without sending it', async (field) => {
    const group = { ...publicFixture.data.groups[0]!, models: [{ name: 'model', platform: 'owner' }] }
    if (field === 'model-name') group.models[0]!.name = key
    else if (field === 'model-platform') group.models[0]!.platform = key
    else if (field === 'name') group.name = key
    else if (field === 'platform') group.platform = key
    else group.description = key
    await failure(publicDirectory({ code: 0, data: { groups: [group] } }), 'DIRECT_AI_INVALID_RESPONSE')
  })

it('measures accumulated raw UTF-8 bytes including ignored fields at exact and undersized limits', async () => {
  const body = JSON.stringify({ data: [{ id: '模型' }], ignored: '界'.repeat(100) })
  const base = await server((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body) })
  expect((await provider(base, { maxResponseBytes: Buffer.byteLength(body) })).models).toEqual([{ id: '模型', platform: 'unknown' }])
  await failure(provider(base, { maxResponseBytes: Buffer.byteLength(body) - 1 }), 'DIRECT_AI_LIMIT')
  await failure(provider(base, { maxResponseBytes: 1 }), 'DIRECT_AI_LIMIT')
})

it('bounds the complete projected JSON even when annotations expand a small response', async () => {
  const body = { code: 0, data: { groups: [{ id: 0, name: '组'.repeat(50), description: '', platform: 'p',
    models: Array.from({ length: 6 }, (_, index) => ({ name: `model-${index}`, platform: 'p' })),
  }] } }
  const expected = await publicDirectory(body)
  const bytes = Buffer.byteLength(JSON.stringify(expected))
  expect(bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(body)))
  expect((await publicDirectory(body, { maxResponseBytes: bytes })).models).toHaveLength(6)
  await failure(publicDirectory(body, { maxResponseBytes: bytes - 1 }), 'DIRECT_AI_LIMIT')
})

it('charges projection limits across groups rather than independently per group', async () => {
  const groups = Array.from({ length: 8 }, (_, id) => ({ id, name: `Group ${id}`, description: '', platform: 'p', models: [{ name: 'm', platform: 'p' }] }))
  const raw = { code: 0, data: { groups } }
  const bodyBytes = Buffer.byteLength(JSON.stringify(raw))
  await failure(publicDirectory(raw, { maxResponseBytes: bodyBytes }), 'DIRECT_AI_LIMIT')
})

it('bounds the result wrapper even for an empty catalog', async () => {
  const raw = { code: 0, data: { groups: [] } }
  await failure(publicDirectory(raw, { maxResponseBytes: Buffer.byteLength(JSON.stringify(raw)) }), 'DIRECT_AI_LIMIT')
})

it('accepts zero-byte chunks and releases a fully consumed keyless public reader', async () => {
  const raw = { code: 0, data: { groups: [{ id: 0, name: 'Public', platform: '', description: '', models: [{ name: 'm', platform: '' }] }] } }
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array())
    controller.enqueue(new TextEncoder().encode(JSON.stringify(raw)))
    controller.close()
  } })
  const directory = await withPublic(() => new Response(body, { headers: { 'content-type': 'application/json' } }), () =>
    readDirectory('aiyoyoo-public', '', undefined, new AbortController().signal, configSchema({})))
  expect(directory.models).toEqual([{ id: 'm', platform: '', groupId: 0, groupName: 'Public' }])
  expect(body.locked).toBe(false)
})

it('cancels an oversized single chunk and releases its response reader', async () => {
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2048)) },
    cancel() { cancelled++ },
  })
  await failure(withPublic(() => new Response(body, { headers: { 'content-type': 'application/json' } }), () =>
    readDirectory('aiyoyoo-public', '', undefined, new AbortController().signal, configSchema({ maxResponseBytes: 100 }))), 'DIRECT_AI_LIMIT')
  expect(cancelled).toBe(1)
  expect(body.locked).toBe(false)
})

it('cancels rejected status and content-type bodies without retaining them', async () => {
  for (const status of [200, 503]) {
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })
    await failure(withPublic(() => new Response(body, { status, headers: { 'content-type': 'text/plain' } }), () =>
      readDirectory('aiyoyoo-public', '', undefined, new AbortController().signal, configSchema({}))),
    status === 200 ? 'DIRECT_AI_INVALID_RESPONSE' : 'DIRECT_AI_HTTP_FAILED')
    expect(cancelled).toBe(1)
    expect(body.locked).toBe(false)
  }
})

it('rejects an absent body as an invalid response', async () => {
  await failure(withPublic(() => new Response(null, { headers: { 'content-type': 'application/json' } }), () =>
    readDirectory('aiyoyoo-public', '', undefined, new AbortController().signal, configSchema({}))), 'DIRECT_AI_INVALID_RESPONSE')
})

it('preserves cancellation before dispatch without sending HTTP', async () => {
  let requests = 0
  const base = await server((_req, res) => { requests++; res.end() })
  const controller = new AbortController()
  const reason = new Error('Caller cancelled')
  controller.abort(reason)
  await expect(provider(base, {}, controller.signal)).rejects.toBe(reason)
  expect(requests).toBe(0)
})

it.each([false, true])('aborts pending provider %s without a retry and closes the response', async (headers) => {
  const controller = new AbortController()
  let ready!: () => void
  let closed!: () => void
  const received = new Promise<void>((resolve) => { ready = resolve })
  const disconnected = new Promise<void>((resolve) => { closed = resolve })
  let requests = 0
  const base = await server((_req, res) => {
    requests++
    res.on('close', closed)
    if (headers) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"data":[')
    }
    ready()
  })
  const operation = provider(base, {}, controller.signal)
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  await received
  controller.abort()
  await rejected
  await disconnected
  expect(requests).toBe(1)
})

it('converts body transport failure to a secret-free HTTP failure and releases the reader', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(key)) } })
  await failure(withPublic(() => new Response(body, { headers: { 'content-type': 'application/json' } }), () =>
    readDirectory('aiyoyoo-public', '', key, new AbortController().signal, configSchema({}))), 'DIRECT_AI_HTTP_FAILED')
  expect(body.locked).toBe(false)
})
