/** Bounded, non-retrying OpenAI protocol execution with explicit HTTP ownership. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.ts'
import type { DirectFrame, DirectRequest, ServiceMetadata } from './types.ts'
import { DirectAiError } from './error.ts'
import { editEndpointOf, endpointOf, parameters, safeUrl } from './validation.ts'

/** One admitted reference image whose bytes already passed attachment verification. */
export interface ProviderImage {
  bytes: Uint8Array
  /** Raster media type verified by the attachment store. */
  mime: ImageMediaType
  /** Optional display name used as the multipart filename. */
  name?: string
}

/** One admitted provider call, including per-operation credential and lifetime. */
export interface ProviderCall {
  service: ServiceMetadata
  request: DirectRequest
  key: string
  signal: AbortSignal
  config: Config
  /** Image capability only: admitted reference images in request order. */
  references: readonly ProviderImage[]
  /** Image capability only: optional admitted mask marking editable areas. */
  mask?: ProviderImage
  /** Store verified bytes before publishing their browser URL. */
  media(bytes: Uint8Array, mime: string): Promise<{ url: string; mime: string }>
}

/** Resource accounting shared by every HTTP response of one operation. */
class Budget {
  response = 0
  media = 0
  constructor(readonly config: Config) {}
  charge(bytes: number, media: boolean): void {
    if (media) this.media += bytes
    else this.response += bytes
    if (this.response > this.config.maxResponseBytes || this.media > this.config.maxMediaBytes) {
      throw new DirectAiError('DIRECT_AI_LIMIT', 'Provider output exceeds the configured size limit.')
    }
  }
}

/** HTTP responses stay owned until their body has been consumed or cancelled. */
async function response(call: ProviderCall, url: URL, init: RequestInit, keyed = true): Promise<Response> {
  let result: Response
  const headers = new Headers(init.headers)
  if (keyed) headers.set('authorization', `Bearer ${call.key}`)
  try {
    result = await fetch(url, { ...init, signal: call.signal, redirect: 'error', headers })
  } catch (_transportFailure) {
    call.signal.throwIfAborted()
    throw new DirectAiError('DIRECT_AI_HTTP_FAILED', 'Provider request failed. Its billing outcome may be unknown; it was not retried.')
  }
  if (!result.ok) {
    await result.body?.cancel()
    throw new DirectAiError('DIRECT_AI_HTTP_FAILED', `Provider returned HTTP ${result.status}. The request was not retried.`)
  }
  return result
}

async function* chunks(result: Response, call: ProviderCall, budget: Budget, media: boolean): AsyncIterable<Uint8Array> {
  const reader = result.body?.getReader()
  if (reader === undefined) throw invalid()
  try {
    while (true) {
      call.signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) return
      budget.charge(next.value.byteLength, media)
      yield next.value
    }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

async function bytes(result: Response, call: ProviderCall, budget: Budget, media: boolean): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of chunks(result, call, budget, media)) {
    parts.push(chunk)
    length += chunk.byteLength
  }
  const value = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { value.set(part, offset); offset += part.length }
  return value
}

async function json(result: Response, call: ProviderCall, budget: Budget): Promise<unknown> {
  const type = result.headers.get('content-type')?.split(';')[0]?.trim()
  if (type !== 'application/json') { await result.body?.cancel(); throw invalid() }
  const value = await bytes(result, call, budget, false)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) } catch (_invalidJson) { throw invalid() }
}

function invalid(): DirectAiError {
  return new DirectAiError('DIRECT_AI_INVALID_RESPONSE', 'Provider returned an unsupported or invalid response.')
}

/** Only inert image/video encodings are served inline; SVG/HTML are never admitted.
 * @param value - complete bounded provider media bytes.
 * @param capability - expected image or video protocol.
 * @returns browser-safe detected media type; advertised Content-Type is not trusted.
 */
export function mediaMime(value: Uint8Array, capability: 'image' | 'video'): string {
  const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (capability === 'image') {
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif'
  } else {
    if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
    if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm'
  }
  throw invalid()
}

/** Prevent a provider echoing its Authorization value across SSE chunk boundaries. */
class SecretFilter {
  private tail = ''
  constructor(private readonly key: string) {}
  push(text: string, final = false): string {
    const value = (this.tail + text).split(this.key).join('[redacted]')
    const keep = final ? 0 : Math.min(this.key.length - 1, value.length)
    this.tail = keep === 0 ? '' : value.slice(-keep)
    return keep === 0 ? value : value.slice(0, -keep)
  }
}

const chatChunk = z.object({
  choices: z.array(z.object({ index: z.literal(0).optional(), delta: z.object({ content: z.string().nullable().optional(),
    tool_calls: z.unknown().optional(), function_call: z.unknown().optional(),
  }), finish_reason: z.string().nullable().optional() })).max(1),
})

async function* chat(call: ProviderCall, budget: Budget, extras: Record<string, unknown>): AsyncIterable<DirectFrame> {
  if (extras.n !== undefined && extras.n !== 1) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Direct chat supports one completion per request; use n: 1 or omit it.')
  }
  const result = await response(call, endpointOf(call.service), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ ...extras, model: call.service.model, messages: call.request.messages, stream: true }),
  })
  if (result.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
    await result.body?.cancel(); throw invalid()
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const filter = new SecretFilter(call.key)
  let pending = ''
  let data: string[] = []
  const state = { completed: false }
  const dispatch = (): string | undefined => {
    if (data.length === 0) return undefined
    const payload = data.join('\n'); data = []
    if (payload === '[DONE]') { state.completed = true; return undefined }
    let raw: unknown
    try { raw = JSON.parse(payload) } catch (_invalidJson) { throw invalid() }
    const parsed = chatChunk.safeParse(raw)
    if (!parsed.success) throw invalid()
    let text = ''
    for (const choice of parsed.data.choices) {
      if (choice.delta.tool_calls !== undefined || choice.delta.function_call !== undefined) throw invalid()
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') throw invalid()
      text += choice.delta.content ?? ''
    }
    return filter.push(text)
  }
  for await (const chunk of chunks(result, call, budget, false)) {
    pending += decoder.decode(chunk, { stream: true })
    while (true) {
      const newline = pending.search(/[\r\n]/)
      if (newline < 0 || (pending[newline] === '\r' && newline === pending.length - 1)) break
      const line = pending.slice(0, newline)
      const width = pending[newline] === '\r' && pending[newline + 1] === '\n' ? 2 : 1
      pending = pending.slice(newline + width)
      if (line === '') {
        const text = dispatch()
        if (text) yield { type: 'text', text }
        if (state.completed) break
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (state.completed) break
  }
  decoder.decode()
  if (!state.completed) throw invalid()
  const text = filter.push('', true)
  if (text) yield { type: 'text', text }
}

const imagesResult = z.object({ data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })).min(1) })
const videoResult = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed', 'cancelled']), progress: z.number().min(0).max(100).optional(),
})

async function* imageFrames(result: Response, call: ProviderCall, budget: Budget): AsyncIterable<DirectFrame> {
  const parsed = imagesResult.safeParse(await json(result, call, budget))
  if (!parsed.success) throw invalid()
  for (const item of parsed.data.data) {
    let content: Uint8Array
    if (item.b64_json !== undefined) {
      if (item.b64_json.length > Math.ceil(call.config.maxMediaBytes / 3) * 4) throw invalid()
      const decoded = Buffer.from(item.b64_json, 'base64')
      if (decoded.toString('base64') !== item.b64_json) throw invalid()
      content = decoded
      budget.charge(content.length, true)
    } else if (item.url !== undefined) {
      // Download URLs never receive provider authorization, even on the same origin.
      content = await bytes(await response(call, safeUrl(item.url, false), { method: 'GET' }, false), call, budget, true)
    } else throw invalid()
    const media = await call.media(content, mediaMime(content, 'image'))
    yield { type: 'media', ...media }
  }
}

async function* images(call: ProviderCall, budget: Budget, extras: Record<string, unknown>, prompt: string): AsyncIterable<DirectFrame> {
  const result = await response(call, endpointOf(call.service), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...extras, model: call.service.model, prompt }),
  })
  yield* imageFrames(result, call, budget)
}

const extensions: Record<ImageMediaType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

/** Use an admitted display name when it survives filename sanitization, otherwise the generated name. */
function filename(name: string | undefined, fallback: string): string {
  const leaf = name?.replace(/[\u0000-\u001f\u007f\\/"*:<>?|]/g, '-').trim()
  return leaf === undefined || leaf === '' ? fallback : leaf
}

async function* imagesEdit(
  call: ProviderCall, budget: Budget, extras: Record<string, unknown>, prompt: string,
): AsyncIterable<DirectFrame> {
  const form = new FormData()
  form.set('model', call.service.model)
  form.set('prompt', prompt)
  for (const [index, reference] of call.references.entries()) {
    form.append('image', new Blob([new Uint8Array(reference.bytes)], { type: reference.mime }),
      filename(reference.name, `image-${index + 1}.${extensions[reference.mime]}`))
  }
  if (call.mask !== undefined) {
    form.append('mask', new Blob([new Uint8Array(call.mask.bytes)], { type: call.mask.mime }),
      filename(call.mask.name, `mask.${extensions[call.mask.mime]}`))
  }
  for (const [key, value] of Object.entries(extras)) form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  // The FormData body owns its multipart boundary; content-type is never set by hand.
  const result = await response(call, editEndpointOf(call.service), { method: 'POST', body: form })
  yield* imageFrames(result, call, budget)
}

async function* video(call: ProviderCall, budget: Budget, extras: Record<string, unknown>, prompt: string): AsyncIterable<DirectFrame> {
  const form = new FormData()
  for (const [key, value] of Object.entries(extras)) {
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  form.set('model', call.service.model); form.set('prompt', prompt)
  const endpoint = endpointOf(call.service)
  let parsed = videoResult.safeParse(await json(await response(call, endpoint, { method: 'POST', body: form }), call, budget))
  if (!parsed.success) throw invalid()
  const id = parsed.data.id
  const statusUrl = new URL(`${endpoint.pathname.replace(/\/$/, '')}/${encodeURIComponent(id)}`, endpoint.origin)
  while (true) {
    const state = parsed.data
    if (state.id !== id) throw invalid()
    yield { type: 'progress', status: state.status, ...state.progress === undefined ? {} : { progress: state.progress } }
    if (state.status === 'completed') break
    if (state.status === 'failed' || state.status === 'cancelled') {
      throw new DirectAiError('DIRECT_AI_HTTP_FAILED', 'Video generation did not complete. The request was not retried.')
    }
    await delay(call.config.pollIntervalMs, undefined, { signal: call.signal })
    parsed = videoResult.safeParse(await json(await response(call, statusUrl, { method: 'GET' }), call, budget))
    if (!parsed.success) throw invalid()
  }
  const content = await bytes(await response(call, new URL(`${statusUrl.pathname}/content`, endpoint.origin), { method: 'GET' }), call, budget, true)
  yield { type: 'media', ...await call.media(content, mediaMime(content, 'video')) }
}

/** Execute exactly one admitted provider operation; no retries, tools, Session or LLM waterfall.
 * @param call - provider selection, complete input, secret and cancellation lifetime.
 * @returns validated incremental result frames; errors terminate the iterable.
 */
export async function* execute(call: ProviderCall): AsyncIterable<DirectFrame> {
  // `request.displayPrompt` is deliberately unread: provider bodies derive from `messages` and admitted parameters only.
  const extras = { ...parameters(call.service.parametersJson), ...parameters(call.request.parametersJson) }
  const editing = call.references.length > 0 || call.mask !== undefined
  if (editing && call.service.capability !== 'image') {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Only image services accept reference images.')
  }
  const budget = new Budget(call.config)
  switch (call.service.capability) {
    case 'chat': yield* chat(call, budget, extras); return
    case 'image':
    case 'video': {
      if (call.request.messages.length !== 1 || call.request.messages[0]?.role !== 'user' || !call.request.messages[0].content.trim()) {
        throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Image and video generation require exactly one non-empty user prompt.')
      }
      const prompt = call.request.messages[0].content
      if (call.service.capability === 'video') yield* video(call, budget, extras, prompt)
      else if (editing) yield* imagesEdit(call, budget, extras, prompt)
      else yield* images(call, budget, extras, prompt)
      return
    }
    default: {
      const exhaustive: never = call.service.capability
      throw new Error(`Unsupported capability: ${String(exhaustive)}`)
    }
  }
}
