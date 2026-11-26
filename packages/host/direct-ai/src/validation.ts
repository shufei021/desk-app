/** Admission of wire JSON, stored configurations and provider URLs. */
import { z } from 'zod'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { Capability, DirectRequest, ServiceId, ServiceMetadata } from './types.ts'
import { DirectAiError } from './error.ts'

/** Stored service schema intentionally has no apiKey field and rejects extra fields. */
export const serviceFieldsSchema = z.object({
  id: z.string().regex(/^s-[0-9a-f-]{36}$/).transform(value => value as ServiceId),
  name: z.string().trim().min(1), capability: z.enum(['chat', 'image', 'video']),
  baseURL: z.string(), model: z.string().trim().min(1),
  endpoint: z.string().optional(), editEndpoint: z.string().optional(), parametersJson: z.string().optional(),
  platform: z.string().trim().min(1).max(256).optional(), groupId: z.number().int().nonnegative().optional(),
  groupName: z.string().trim().min(1).max(512).optional(),
}).strict()

/** Stored metadata normalized to omit absent optional wire fields. */
export const serviceSchema = serviceFieldsSchema.transform(value => ({
  id: value.id, name: value.name, capability: value.capability, baseURL: value.baseURL, model: value.model,
  ...value.endpoint === undefined ? {} : { endpoint: value.endpoint },
  ...value.editEndpoint === undefined ? {} : { editEndpoint: value.editEndpoint },
  ...value.parametersJson === undefined ? {} : { parametersJson: value.parametersJson },
  ...value.platform === undefined ? {} : { platform: value.platform },
  ...value.groupId === undefined ? {} : { groupId: value.groupId },
  ...value.groupName === undefined ? {} : { groupName: value.groupName },
}))

const mediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const dimensionSchema = z.number().int().positive().max(16_384)

const referenceSchema = z.object({
  attachmentId: z.string().transform(value => value as AttachmentId),
  mediaType: mediaTypeSchema, width: dimensionSchema, height: dimensionSchema,
  bytes: z.number().int().nonnegative(),
  name: z.string().max(512).optional(),
  originalDimensions: z.object({ width: dimensionSchema, height: dimensionSchema }).strict().optional(),
}).strict().transform((value): ImageAttachmentRef => ({
  attachmentId: value.attachmentId, mediaType: value.mediaType, width: value.width, height: value.height, bytes: value.bytes,
  ...value.name === undefined ? {} : { name: value.name },
  ...value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions },
}))

/** Validate complete request JSON at direct invocation and durable read entry points.
 * `displayPrompt` is retained display text, so it is trimmed and length-bounded but never a provider parameter.
 */
export const requestSchema = z.object({
  serviceId: z.string().transform(value => value as ServiceId),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
  parametersJson: z.string().optional(),
  displayPrompt: z.string().trim().max(4000).optional(),
  references: z.array(referenceSchema).max(8).optional(),
  mask: referenceSchema.optional(),
}).strict().transform(value => ({
  serviceId: value.serviceId, messages: value.messages,
  ...value.parametersJson === undefined ? {} : { parametersJson: value.parametersJson },
  ...value.displayPrompt === undefined ? {} : { displayPrompt: value.displayPrompt },
  ...value.references === undefined ? {} : { references: value.references },
  ...value.mask === undefined ? {} : { mask: value.mask },
}))

const reserved = new Set(['model', 'messages', 'prompt', 'stream', 'tools', 'tool_choice', 'functions', 'function_call',
  'parallel_tool_calls', 'api_key', 'apiKey', 'authorization', 'headers', 'image', 'mask', '__proto__', 'constructor', 'prototype'])

/** Parse provider parameters without permitting identity overrides, credentials or tool execution.
 * @param json - optional JSON object; omission means no extra parameters.
 * @returns validated object with provider-owned ordinary JSON values.
 */
export function parameters(json?: string): Record<string, unknown> {
  if (json === undefined || json.trim() === '') return {}
  let value: unknown
  try { value = JSON.parse(json) } catch (_invalidJson) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Parameters must be a JSON object.')
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Parameters must be a JSON object.')
  }
  const record = value as Record<string, unknown>
  const inspect = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (reserved.has(key)) throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Parameters contain a reserved field.')
      inspect(child)
    }
  }
  inspect(record)
  return record
}

/** Admit an HTTP(S) URL without userinfo or fragments; cleartext is limited to numeric loopback.
 * @param input - absolute provider or media URL.
 * @param base - whether query strings must also be absent.
 * @returns parsed safe URL, without making a network request.
 */
export function safeUrl(input: string, base: boolean): URL {
  let url: URL
  try { url = new URL(input) } catch (_invalidUrl) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'The provider URL is invalid.')
  }
  const loopback = url.hostname === '[::1]' || url.hostname === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (base && url.search)
    || (url.protocol === 'http:' && !loopback)) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Use HTTPS without user information, query or fragment; HTTP is limited to loopback.')
  }
  return url
}

const defaults: Record<Capability, string> = { chat: 'chat/completions', image: 'images/generations', video: 'videos' }

/** Resolve one endpoint beneath the provider origin without permitting an origin or query override. */
function submission(service: ServiceMetadata, endpoint: string): URL {
  const base = safeUrl(service.baseURL, true)
  if (!endpoint || endpoint.startsWith('//') || endpoint.includes('\\') || /[?#]/.test(endpoint)
    || /^[a-z][a-z\d+.-]*:/i.test(endpoint)) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Endpoint must be a same-origin path without query or fragment.')
  }
  const url = new URL(endpoint, base.href.endsWith('/') ? base : `${base.href}/`)
  if (url.origin !== base.origin || url.username || url.password) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Endpoint must remain on the provider origin.')
  }
  return url
}

/** Resolve a configured endpoint without permitting an origin or query override.
 * @param service - admitted provider metadata.
 * @returns same-origin submission URL.
 */
export function endpointOf(service: ServiceMetadata): URL {
  return submission(service, service.endpoint ?? defaults[service.capability])
}

/** Derive the edit path from the generation path, falling back to `images/edits`. */
function edited(endpoint: string): string {
  const segments = endpoint.split('/')
  if (segments[segments.length - 1] !== 'generations') return 'images/edits'
  segments[segments.length - 1] = 'edits'
  return segments.join('/')
}

/** Resolve the image-edit submission URL for one image service.
 * An explicit `editEndpoint` wins; otherwise a final `generations` path segment becomes `edits`, and any
 * other endpoint resolves to `images/edits`. Origin, query and fragment rules match {@link endpointOf}.
 * @param service - admitted provider metadata.
 * @returns same-origin image-edit URL.
 */
export function editEndpointOf(service: ServiceMetadata): URL {
  return submission(service, service.editEndpoint ?? edited(service.endpoint ?? defaults[service.capability]))
}

/** Resolve defaults and validate provider metadata before persistence or HTTP.
 * @param input - non-secret metadata.
 * @returns normalized metadata containing no credential.
 */
export function metadata(input: ServiceMetadata): ServiceMetadata {
  const value = { name: input.name.trim(), capability: input.capability, baseURL: safeUrl(input.baseURL, true).href,
    model: input.model.trim(),
    ...input.endpoint === undefined ? {} : { endpoint: input.endpoint },
    ...input.editEndpoint === undefined ? {} : { editEndpoint: input.editEndpoint },
    ...input.parametersJson === undefined ? {} : { parametersJson: input.parametersJson },
    ...input.platform === undefined ? {} : { platform: input.platform.trim() },
    ...input.groupId === undefined ? {} : { groupId: input.groupId },
    ...input.groupName === undefined ? {} : { groupName: input.groupName.trim() },
  }
  if (!value.name || !value.model) throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Service name and model are required.')
  endpointOf(value)
  if (value.editEndpoint !== undefined) editEndpointOf(value)
  parameters(value.parametersJson)
  return value
}

/** Validate wire input and its complete serialized byte size.
 * @param request - received request JSON.
 * @param limit - maximum complete encoded input bytes.
 * @returns parsed full input, safe to retain without credentials.
 */
export function admitRequest(request: DirectRequest, limit: number): DirectRequest {
  const result = requestSchema.safeParse(request)
  if (!result.success || Buffer.byteLength(JSON.stringify(request)) > limit) {
    throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Request is invalid or exceeds the configured input limit.')
  }
  parameters(result.data.parametersJson)
  return result.data
}
