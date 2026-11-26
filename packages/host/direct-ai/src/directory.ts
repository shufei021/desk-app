/** Validated public and authenticated provider catalogs, without capability inference or retries. */
import { z } from 'zod'
import type { Config } from './config.ts'
import type { DirectoryGroup, DirectoryModel, ModelDirectory } from './types.ts'
import { DirectAiError } from './error.ts'
import { safeUrl } from './validation.ts'

const publicUrl = 'https://www.aiyoyoo.com/api/v1/llm-pricing/models'
const nonempty = z.string().regex(/\S/)
const publicResponse = z.object({
  code: z.literal(0),
  data: z.object({ groups: z.array(z.object({
    id: z.number().int().nonnegative(), name: nonempty, platform: z.string(), description: z.string(),
    models: z.array(z.object({ name: nonempty, platform: z.string() })),
  })) }),
})
const providerResponse = z.object({
  data: z.array(z.object({ id: nonempty, owned_by: nonempty.optional() })),
  object: z.string().optional(),
})

function invalid(): DirectAiError {
  return new DirectAiError('DIRECT_AI_INVALID_RESPONSE', 'Model directory returned an unsupported or invalid response.')
}

function limited(): DirectAiError {
  return new DirectAiError('DIRECT_AI_LIMIT', 'Model directory exceeds the configured size limit.')
}

async function discard(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try { await body?.cancel() } catch (_cancelFailed) {
    // The response is discarded; cancellation failure cannot make its content safe to return.
  }
}

async function json(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await discard(response.body)
    throw invalid()
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw invalid()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      length += next.value.byteLength
      if (length > limit) throw limited()
      if (next.value.byteLength > 0) parts.push(next.value)
    }
  } finally {
    try { await reader.cancel() } catch (_cancelFailed) {
      // Reading has settled; preserve its original failure while releasing the discarded response.
    } finally { reader.releaseLock() }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_invalidJson) { throw invalid() }
}

/** Accounts for the complete projected JSON before adding repeated group annotations. */
class Projection {
  readonly value: ModelDirectory
  private bytes: number
  constructor(source: ModelDirectory['source'], private readonly limit: number, private readonly key: string | undefined) {
    this.value = { source, models: [], groups: [], fetchedAt: Date.now() }
    this.bytes = Buffer.byteLength(JSON.stringify(this.value))
    if (this.bytes > limit) throw limited()
  }
  group(item: DirectoryGroup): void {
    this.charge(item, this.value.groups.length)
    this.value.groups.push(item)
  }
  model(item: DirectoryModel): void {
    this.charge(item, this.value.models.length)
    this.value.models.push(item)
  }
  private charge(item: DirectoryGroup | DirectoryModel, count: number): void {
    if (this.key) {
      for (const value of Object.values(item)) {
        if (typeof value === 'string' && value.includes(this.key)) throw invalid()
      }
    }
    this.bytes += Buffer.byteLength(JSON.stringify(item)) + (count > 0 ? 1 : 0)
    if (this.bytes > this.limit) throw limited()
  }
}

function project(raw: unknown, source: ModelDirectory['source'], key: string | undefined, limit: number): ModelDirectory {
  const output = new Projection(source, limit, key)
  if (source === 'aiyoyoo-public') {
    const parsed = publicResponse.safeParse(raw)
    if (!parsed.success) throw invalid()
    const groups = new Set<number>()
    for (const group of parsed.data.data.groups) {
      if (groups.has(group.id)) throw invalid()
      groups.add(group.id)
      output.group({ id: group.id, name: group.name, platform: group.platform, description: group.description })
      const models = new Set<string>()
      for (const model of group.models) {
        if (models.has(model.name)) throw invalid()
        models.add(model.name)
        output.model({ id: model.name, platform: model.platform, groupId: group.id, groupName: group.name })
      }
    }
  } else {
    const parsed = providerResponse.safeParse(raw)
    if (!parsed.success) throw invalid()
    const models = new Set<string>()
    for (const model of parsed.data.data) {
      if (models.has(model.id)) throw invalid()
      models.add(model.id)
      output.model({ id: model.id, platform: model.owned_by ?? 'unknown' })
    }
  }
  return output.value
}

/** Read exactly one catalog; public requests always use the fixed keyless URL.
 * Response bytes and complete projected JSON each obey maxResponseBytes. Invalid or secret-bearing
 * fields reject the entire response. Bodies are consumed or cancelled before settlement; no partial
 * catalog is returned. The caller supplies the combined cancellation/deadline signal.
 * @param source - fixed public catalog or authenticated standard provider models endpoint.
 * @param baseURL - provider API base URL; ignored for the public catalog.
 * @param key - required provider credential; never sent to the public catalog, even when supplied.
 * @param signal - caller-owned cancellation and timeout lifetime; its abort reason is preserved.
 * @param config - admitted request and response byte limits.
 * @returns validated model/group annotations without inferred capabilities or billing entitlements.
 * @throws DirectAiError for missing credentials, invalid URLs, HTTP failures, invalid JSON or size limits.
 */
export async function readDirectory(
  source: 'aiyoyoo-public' | 'provider', baseURL: string, key: string | undefined, signal: AbortSignal, config: Config,
): Promise<ModelDirectory> {
  signal.throwIfAborted()
  try {
    let url: URL
    const headers = new Headers({ accept: 'application/json' })
    if (source === 'aiyoyoo-public') url = new URL(publicUrl)
    else {
      if (!key) throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Configure an API key before reading the provider model directory.')
      const base = safeUrl(baseURL, true)
      url = new URL('models', base.href.endsWith('/') ? base : `${base.href}/`)
      headers.set('authorization', `Bearer ${key}`)
    }
    if (Buffer.byteLength(JSON.stringify({ url: url.href, headers: Object.fromEntries(headers) })) > config.maxRequestBytes) throw limited()
    const response = await fetch(url, { method: 'GET', headers, signal, redirect: 'error' })
    if (!response.ok) {
      await discard(response.body)
      throw new DirectAiError('DIRECT_AI_HTTP_FAILED', `Model directory returned HTTP ${response.status}. The request was not retried.`)
    }
    return project(await json(response, signal, config.maxResponseBytes), source, key, config.maxResponseBytes)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof DirectAiError) throw error
    throw new DirectAiError('DIRECT_AI_HTTP_FAILED', 'Model directory request failed. The request was not retried.')
  }
}
