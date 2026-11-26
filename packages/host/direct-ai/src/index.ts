/** Owner-only Remote inference and durable image execution for independently authorized Host consumers. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { configSchema, type Config } from './config.ts'
import { DirectAiError } from './error.ts'
import { execute, type ProviderImage } from './protocol.ts'
import { readDirectory } from './directory.ts'
import { directDomain, storedServiceSchema } from './storage.ts'
import { admitRequest, metadata, serviceFieldsSchema } from './validation.ts'
import type {
  DirectorySource, ModelDirectory, DirectFrame, DirectRequest, GeneratedImageResult,
  RunId, RunRecord, ServiceId, ServiceInput, ServiceView,
} from './types.ts'

export type * from './types.ts'
export type { Config } from './config.ts'
export { DirectAiError } from './error.ts'

interface Operation { controller: AbortController; done: Promise<void> }
interface ImageDestination { store: AttachmentStore; images: ImageAttachmentRef[] }

const inputSchema = serviceFieldsSchema.omit({ id: true }).extend({
  id: serviceFieldsSchema.shape.id.optional(), apiKey: z.string().optional(),
}).strict()

const uploadSchema = z.object({
  data: z.string().min(1), mime: z.string(), name: z.string().max(512).optional(),
}).strict()

/** Provider output must retain a supported raster type before entering durable attachment storage. */
function isImageMime(mime: string): mime is ImageMediaType {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif'
}

/** Failure conversion deliberately excludes foreign messages, bodies, URLs, causes and secrets. */
function safeFailure(error: unknown, signal?: AbortSignal): DirectAiError {
  if (error instanceof DirectAiError) return error
  if (signal?.aborted === true) {
    if (signal.reason instanceof DirectAiError) return signal.reason
    return new DirectAiError('DIRECT_AI_CANCELLED', 'Request cancelled. Provider work already submitted may still be billed.')
  }
  return new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Direct AI could not finish safely. Check private storage before submitting another request.')
}

declare module '@deepseek-ai/cordis' {
  interface Context { directAi: DirectAi }
}

/** Personal provider configuration, durable inference and image attachments, and owner-authenticated private media. */
export default class DirectAi extends TypertRemoteService {
  static inject = ['storageDomain', 'credentials', 'connection']
  static Config = configSchema
  private readonly config: Config
  private readonly directory: string
  private readonly ready: Promise<Domain<typeof directDomain>>
  private readonly operations = new Set<Operation>()
  private readonly mediaRequests = new Set<Promise<Response>>()
  private readonly mediaLifetime = new AbortController()
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, config: Config = configSchema({})) {
    super(ctx, 'directAi')
    this.config = configSchema(config)
    this.directory = dshPath({ category: 'data', dshHome: this.config.dshHome }, 'direct-ai', 'media')
    this.ready = this.initialize()
    // Register the disposer before awaiting initialization so failed startup also closes its domain.
    ctx.effect(() => async () => {
      this.closed = true
      this.mediaLifetime.abort()
      await Promise.allSettled([...this.mediaRequests])
      for (const operation of this.operations) operation.controller.abort(new DirectAiError('DIRECT_AI_CANCELLED', 'Direct AI is shutting down.'))
      await Promise.all([...this.operations].map(operation => operation.done))
      await this.writes
      const domain = await this.ready.catch(() => undefined)
      await domain?.close()
    })
    ctx.connection.fetch.register({ path: '/api/direct-ai/media', methods: ['GET', 'HEAD'], requestBody: 'buffered',
      // Connection's exact route dispatcher authenticates and checks owner before calling this handler.
      fetch: (request) => {
        const pending = this.mediaResponse(new Request(request, { signal: AbortSignal.any([request.signal, this.mediaLifetime.signal]) }))
        this.mediaRequests.add(pending)
        void pending.then(() => this.mediaRequests.delete(pending), () => this.mediaRequests.delete(pending))
        return pending
      },
    })
    ctx.effect(async () => { await this.ready; return () => {} })
  }

  private async initialize(): Promise<Domain<typeof directDomain>> {
    const domain = await this.ctx.storageDomain.open(directDomain)
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Private media directory is not a real directory.')
      await chmod(this.directory, 0o700)
      for (const [id, service] of domain.table('services').entries()) {
        if (id !== service.id) throw new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Stored service identity is invalid.')
        metadata(service)
      }
      for (const [id, media] of domain.table('media').entries()) {
        if (id !== media.id) throw new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Stored media identity is invalid.')
      }
      for (const [id, run] of domain.table('runs').entries()) {
        if (id !== run.id) throw new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Stored request identity is invalid.')
        if (run.status === 'running') await domain.table('runs').put(id, { ...run, status: 'cancelled', finishedAt: Date.now(),
          error: { code: 'DIRECT_AI_CANCELLED', message: 'The Host stopped before this request settled; provider billing may be unknown.' },
        })
      }
      // Only exclusively generated opaque filenames are reclaimed; unrelated files are never touched.
      for (const name of await readdir(this.directory)) {
        if (/^[0-9a-f-]{36}$/.test(name) && domain.table('media').get(name) === undefined) await unlink(join(this.directory, name))
      }
      await this.prune(domain)
      return domain
    } catch (error) {
      await domain.close()
      throw safeFailure(error)
    }
  }

  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new DirectAiError('DIRECT_AI_FORBIDDEN', 'Direct AI is available only to the Host owner.')
    if (this.closed) throw new DirectAiError('DIRECT_AI_CLOSED', 'Direct AI is shutting down.')
  }

  private async store(): Promise<Domain<typeof directDomain>> {
    try { return await this.ready } catch (error) { throw safeFailure(error) }
  }

  private serialized<T>(job: () => Promise<T>): Promise<T> {
    const result = this.writes.then(job)
    this.writes = result.then(() => {}, () => {})
    return result.catch((error: unknown) => { throw safeFailure(error) })
  }

  private async view(service: z.infer<typeof storedServiceSchema>): Promise<ServiceView> {
    const info = service.credentialId === undefined ? undefined
      : await this.ctx.credentials.describeRecord(credentialKey('direct-ai', service.credentialId))
    return { ...metadata(service), id: service.id, configured: info?.configured === true && info.kind === 'api-key' }
  }

  private async reclaimCredential(id: string | undefined): Promise<void> {
    if (id === undefined) return
    try { await this.ctx.credentials.deleteRecord(credentialKey('direct-ai', id)) }
    catch (_cleanupFailed) {
      this.ctx.logger.warn('direct-ai: an unreachable old credential could not be removed; the saved service remains authoritative.')
    }
  }

  /** Read saved non-secret services; a new home returns an empty list.
   * @returns saved metadata and credential presence, never credential contents.
   */
  @Remote
  async catalog(): Promise<ServiceView[]> {
    this.owner()
    try { return await Promise.all([...((await this.store()).table('services').entries())].map(([, service]) => this.view(service))) }
    catch (error) { throw safeFailure(error) }
  }

  /** Save metadata and optionally replace or remove its separately stored credential.
   * @param input - omitted apiKey preserves its current value; empty apiKey removes it.
   * @returns committed service metadata and current credential presence.
   */
  @Remote
  async save(input: ServiceInput): Promise<ServiceView> {
    this.owner()
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > this.config.maxRequestBytes) {
      throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Service configuration is invalid or too large.')
    }
    const admitted = metadata({
      name: parsed.data.name, capability: parsed.data.capability, model: parsed.data.model, baseURL: parsed.data.baseURL,
      ...parsed.data.endpoint === undefined ? {} : { endpoint: parsed.data.endpoint },
      ...parsed.data.editEndpoint === undefined ? {} : { editEndpoint: parsed.data.editEndpoint },
      ...parsed.data.parametersJson === undefined ? {} : { parametersJson: parsed.data.parametersJson },
      ...parsed.data.platform === undefined ? {} : { platform: parsed.data.platform },
      ...parsed.data.groupId === undefined ? {} : { groupId: parsed.data.groupId },
      ...parsed.data.groupName === undefined ? {} : { groupName: parsed.data.groupName },
    })
    if (parsed.data.apiKey !== undefined && /[\r\n]/.test(parsed.data.apiKey)) {
      throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'API key must not contain line breaks.')
    }
    return this.serialized(async () => {
      const domain = await this.store()
      const id = parsed.data.id ?? `s-${randomUUID()}` as ServiceId
      const previous = domain.table('services').get(id)
      if (parsed.data.id !== undefined && previous === undefined) throw new DirectAiError('DIRECT_AI_NOT_FOUND', 'Service was not found.')
      const apiKey = parsed.data.apiKey
      let credentialId = apiKey === '' ? undefined : previous?.credentialId
      if (apiKey !== undefined && apiKey !== '') {
        credentialId = `c-${randomUUID()}`
        await this.ctx.credentials.modifyRecord(credentialKey('direct-ai', credentialId), () => Promise.resolve({ kind: 'api-key', key: apiKey }))
      }
      // Commit metadata and its immutable credential pointer together; failed writes cannot mix endpoints and keys.
      const service = { ...admitted, id, ...credentialId === undefined ? {} : { credentialId } }
      await domain.table('services').put(id, service)
      if (previous?.credentialId !== credentialId) await this.reclaimCredential(previous?.credentialId)
      return this.view(service)
    })
  }

  /** Remove a service and its credential; existing runs and history retain their non-secret snapshots.
   * @param id - opaque saved service identifier.
   */
  @Remote
  async removeService(id: ServiceId): Promise<void> {
    this.owner()
    if (!serviceFieldsSchema.shape.id.safeParse(id).success) throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Service identifier is invalid.')
    await this.serialized(async () => {
      const domain = await this.store()
      const previous = domain.table('services').get(id)
      await domain.table('services').delete(id)
      await this.reclaimCredential(previous?.credentialId)
    })
  }

  /** Return full retained direct-request records, independent of Session logs.
   * @returns newest-first complete inputs and settled/partial outputs, without credentials.
   */
  @Remote
  async history(): Promise<RunRecord[]> {
    this.owner()
    const domain = await this.store()
    return [...domain.table('runs').entries()].map(([, run]) => run).sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Store one owner-selected reference image and return its durable attachment reference.
   * The returned reference is accepted unchanged by `DirectRequest.references` or `DirectRequest.mask`;
   * image bytes live only in attachment storage and never in a direct request record.
   * @param input - canonical base64 without a data prefix, declared raster media type, and optional display name.
   * @param signal - cancellation from the editor or Remote transport.
   * @returns durable attachment reference for the normalized stored image.
   */
  @Remote
  async uploadReference(input: { data: string; mime: string; name?: string }, signal: AbortSignal): Promise<ImageAttachmentRef> {
    this.owner()
    const parsed = uploadSchema.safeParse(input)
    if (!parsed.success) throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'The reference image upload is invalid.')
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Durable image storage is unavailable; no image was stored.')
    try {
      signal.throwIfAborted()
      if (parsed.data.data.length > Math.ceil(this.config.maxMediaBytes / 3) * 4) {
        throw new DirectAiError('DIRECT_AI_LIMIT', 'The reference image exceeds the configured media byte limit.')
      }
      const data = Buffer.from(parsed.data.data, 'base64')
      if (data.toString('base64') !== parsed.data.data) {
        throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Reference images must use canonical base64 without a data prefix.')
      }
      if (!isImageMime(parsed.data.mime)) {
        throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Reference images must be PNG, JPEG, WebP or GIF.')
      }
      if (data.byteLength > this.config.maxMediaBytes) {
        throw new DirectAiError('DIRECT_AI_LIMIT', 'The reference image exceeds the configured media byte limit.')
      }
      signal.throwIfAborted()
      return await attachments.saveImage({
        data, mediaType: parsed.data.mime, ...parsed.data.name === undefined ? {} : { name: parsed.data.name },
      })
    } catch (error) {
      throw safeFailure(error, signal)
    }
  }

  /** Read an explicit provider or public directory without invoking a model or changing an account group.
   * @param source - public listing, saved service, or a draft URL paired with its own explicit key.
   * @param signal - cancellation from the editor or Remote transport.
   * @returns provider-supplied identifiers and annotations, never a claim of key entitlement or model capability.
   */
  @Remote
  async discoverModels(source: DirectorySource, signal: AbortSignal): Promise<ModelDirectory> {
    this.owner()
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('aiyoyoo-public') }).strict(),
      z.object({ kind: z.literal('saved'), serviceId: serviceFieldsSchema.shape.id }).strict(),
      z.object({ kind: z.literal('draft'), baseURL: z.string(), apiKey: z.string().min(1) }).strict(),
    ])
    const parsed = schema.safeParse(source)
    if (!parsed.success || Buffer.byteLength(JSON.stringify(source)) > this.config.maxRequestBytes) {
      throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Directory source is invalid or too large.')
    }
    if (this.operations.size >= this.config.maxConcurrent) {
      throw new DirectAiError('DIRECT_AI_BUSY', 'Direct AI has reached its concurrent-request limit.')
    }
    const controller = new AbortController()
    const operation: Operation = { controller, done: Promise.resolve() }
    const settled = Promise.withResolvers<undefined>()
    operation.done = settled.promise.then(() => {})
    this.operations.add(operation)
    const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    try {
      combined.throwIfAborted()
      let baseURL = ''
      let key: string | undefined
      const admitted = parsed.data
      if (admitted.kind === 'draft') { baseURL = admitted.baseURL; key = admitted.apiKey }
      else if (admitted.kind === 'saved') {
        const snapshot = await this.serialized(async () => {
          combined.throwIfAborted()
          const service = (await this.store()).table('services').get(admitted.serviceId)
          if (service === undefined) throw new DirectAiError('DIRECT_AI_NOT_FOUND', 'Service was not found.')
          const credential = service.credentialId === undefined ? undefined
            : await this.ctx.credentials.readRecord(credentialKey('direct-ai', service.credentialId))
          if (credential?.kind !== 'api-key' || !credential.key) {
            throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Configure an API key before reading provider models.')
          }
          return { baseURL: service.baseURL, key: credential.key }
        })
        baseURL = snapshot.baseURL
        key = snapshot.key
      }
      return await readDirectory(admitted.kind === 'aiyoyoo-public' ? 'aiyoyoo-public' : 'provider', baseURL, key, combined, this.config)
    } catch (error) {
      if (combined.aborted && !controller.signal.aborted && !signal.aborted) {
        throw new DirectAiError('DIRECT_AI_TIMEOUT', 'Model directory request timed out.')
      }
      throw safeFailure(error, combined)
    } finally {
      controller.abort()
      this.operations.delete(operation)
      settled.resolve(undefined)
    }
  }

  /** Generate durable images for an authorized trusted Host consumer; this is not a Remote operation.
   * Callers own authorization of the user or Session that may spend the saved service's credential.
   * @param serviceId - existing image service; callers cannot override its URL, model, key or parameters.
   * @param prompt - complete generation instruction retained before HTTP submission.
   * @param signal - consumer-owned cancellation; submitted provider work may still incur charges.
   * @returns attachment references only after direct-history completion is durable; no request is retried.
   */
  async generateImage(serviceId: ServiceId, prompt: string, signal: AbortSignal): Promise<GeneratedImageResult> {
    if (this.closed) throw new DirectAiError('DIRECT_AI_CLOSED', 'Direct AI is shutting down.')
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Durable image storage is unavailable; no generation was submitted.')
    const request = admitRequest({ serviceId, messages: [{ role: 'user', content: prompt }] }, this.config.maxRequestBytes)
    const destination: ImageDestination = { store: attachments, images: [] }
    const operation = this.startOperation(signal)
    try {
      const record = await this.perform(request, operation.controller, () => {}, destination)
      return { runId: record.id, service: { id: record.service.id, name: record.service.name, model: record.service.model },
        images: destination.images }
    } catch (error) {
      throw safeFailure(error, operation.controller.signal)
    } finally { operation.finish() }
  }

  private startOperation(signal: AbortSignal): { controller: AbortController; finish(): void } {
    if (this.closed) throw new DirectAiError('DIRECT_AI_CLOSED', 'Direct AI is shutting down.')
    if (this.operations.size >= this.config.maxConcurrent) throw new DirectAiError('DIRECT_AI_BUSY', 'Direct AI has reached its concurrent-request limit.')
    const controller = new AbortController()
    const settled = Promise.withResolvers<undefined>()
    const operation: Operation = { controller, done: settled.promise.then(() => {}) }
    const abort = (): void => { controller.abort(new DirectAiError('DIRECT_AI_CANCELLED', 'Request cancelled. Submitted provider work may still be billed.')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    this.operations.add(operation)
    return { controller, finish: () => {
      controller.abort()
      signal.removeEventListener('abort', abort)
      this.operations.delete(operation)
      settled.resolve(undefined)
    } }
  }

  /** Submit one non-retrying request and stream validated results. Closing the iterable cancels HTTP and polling.
   * @param request - complete textual input and optional parameter overrides; no tool fields are accepted.
   * @param signal - cancellation from the caller or Remote transport.
   * @returns incremental frames; done follows durable success, and failure/cancellation rejects after durable settlement.
   */
  @Remote({ mode: 'stream' })
  async *run(request: DirectRequest, signal: AbortSignal): AsyncIterable<DirectFrame> {
    this.owner()
    const admitted = admitRequest(request, this.config.maxRequestBytes)
    if (this.operations.size >= this.config.maxConcurrent) throw new DirectAiError('DIRECT_AI_BUSY', 'Direct AI has reached its concurrent-request limit.')
    const controller = new AbortController()
    const operation: Operation = { controller, done: Promise.resolve() }
    this.operations.add(operation)
    const abort = (): void => { controller.abort(new DirectAiError('DIRECT_AI_CANCELLED', 'Request cancelled. Submitted provider work may still be billed.')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const queue: DirectFrame[] = []
    let wake: (() => void) | undefined
    const state = { settled: false }
    let failure: DirectAiError | undefined
    const publish = (frame: DirectFrame): void => { queue.push(frame); wake?.(); wake = undefined }
    operation.done = this.perform(admitted, controller, publish).then(() => {}).catch((error: unknown) => {
      failure = safeFailure(error, controller.signal)
    }).finally(() => {
      state.settled = true; wake?.(); wake = undefined
      this.operations.delete(operation)
      signal.removeEventListener('abort', abort)
    })
    try {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (state.settled) { if (failure !== undefined) throw failure; return }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      if (!state.settled) abort()
      await operation.done
    }
  }

  private async perform(
    request: DirectRequest, controller: AbortController, publish: (frame: DirectFrame) => void, destination?: ImageDestination,
  ): Promise<RunRecord> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let record: RunRecord | undefined
    const domain = await this.store()
    try {
      const snapshot = await this.serialized(async () => {
        controller.signal.throwIfAborted()
        const service = domain.table('services').get(request.serviceId)
        if (service === undefined) throw new DirectAiError('DIRECT_AI_NOT_FOUND', 'Service was not found.')
        if (destination !== undefined && service.capability !== 'image') {
          throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Select an image service before generating images; no request was submitted.')
        }
        const credential = service.credentialId === undefined ? undefined
          : await this.ctx.credentials.readRecord(credentialKey('direct-ai', service.credentialId))
        if (destination !== undefined && (credential?.kind !== 'api-key' || !credential.key)) {
          throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Configure an API key before generating images; no request was submitted.')
        }
        const initial: RunRecord = { id: `r-${randomUUID()}` as RunId, service: { ...metadata(service), id: service.id }, request,
          startedAt: Date.now(), status: 'running', frames: [] }
        if (Buffer.byteLength(JSON.stringify(initial)) > this.config.maxRequestBytes) {
          throw new DirectAiError('DIRECT_AI_LIMIT', 'Complete retained request exceeds the configured input limit.')
        }
        await domain.table('runs').put(initial.id, initial)
        record = initial
        if (credential?.kind !== 'api-key' || !credential.key) {
          throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Configure an API key before submitting this service.')
        }
        return { service, key: credential.key, record: initial }
      })
      const { service, key } = snapshot
      record = snapshot.record
      const editing = (request.references?.length ?? 0) > 0 || request.mask !== undefined
      if (editing && service.capability !== 'image') {
        throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'Only image services accept reference images.')
      }
      const references = editing ? await this.referenceImages(request, controller.signal) : { references: [] }
      timer = setTimeout(() => { controller.abort(new DirectAiError('DIRECT_AI_TIMEOUT', 'Direct AI request timed out. Submitted provider work may still be billed.')) },
        service.capability === 'video' ? this.config.videoTimeoutMs : this.config.requestTimeoutMs)
      controller.signal.throwIfAborted()
      const frames: DirectFrame[] = []
      const runId = record.id
      let outputBytes = Buffer.byteLength(JSON.stringify([]))
      for await (const frame of execute({ service: metadata(service), request, key, signal: controller.signal,
        config: this.config, references: references.references,
        ...references.mask === undefined ? {} : { mask: references.mask },
        media: async (content, mime) => {
          if (destination !== undefined) {
            if (!isImageMime(mime)) throw new DirectAiError('DIRECT_AI_INVALID_RESPONSE', 'Provider did not return a supported image.')
            controller.signal.throwIfAborted()
            const attachment = await destination.store.saveImage({ data: content, mediaType: mime })
            controller.signal.throwIfAborted()
            const complete = [...destination.images, attachment]
            const result = { runId, service: { id: service.id, name: service.name, model: service.model }, images: complete }
            if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxResponseBytes) {
              throw new DirectAiError('DIRECT_AI_LIMIT', 'Complete generated-image result exceeds the configured response limit.')
            }
            destination.images.push(attachment)
          }
          return this.writeMedia(domain, runId, content, mime, controller.signal)
        },
      })) {
        controller.signal.throwIfAborted()
        outputBytes += Buffer.byteLength(JSON.stringify(frame)) + 1
        if (outputBytes > this.config.maxResponseBytes) throw new DirectAiError('DIRECT_AI_LIMIT', 'Retained output exceeds the configured response limit.')
        frames.push(frame)
        record = { ...record, frames }
        publish(frame)
      }
      controller.signal.throwIfAborted()
      const done: DirectFrame = { type: 'done' }
      if (outputBytes + Buffer.byteLength(JSON.stringify(done)) + 1 > this.config.maxResponseBytes) throw new DirectAiError('DIRECT_AI_LIMIT', 'Retained output exceeds the configured response limit.')
      const completed: RunRecord = { ...record, status: 'completed', finishedAt: Date.now(), frames: [...frames, done] }
      await domain.table('runs').put(record.id, completed)
      publish(done)
      await this.serialized(() => this.prune(domain)).catch(() => {
        this.ctx.logger.warn('direct-ai: history retention cleanup failed; the completed request remains saved. Check private storage before requesting more media.')
      })
      return completed
    } catch (error) {
      const failure = safeFailure(error, controller.signal)
      if (record !== undefined) {
        await domain.table('runs').put(record.id, { ...record, finishedAt: Date.now(),
          status: failure.code === 'DIRECT_AI_CANCELLED' ? 'cancelled' : 'failed', error: { code: failure.code, message: failure.message },
        }).catch(() => { throw new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Request settlement could not be saved; provider billing may be unknown.') })
        await this.serialized(() => this.prune(domain)).catch(() => {
          this.ctx.logger.warn('direct-ai: history retention cleanup failed; the failed request remains saved. Check private storage.')
        })
      }
      throw failure
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }

  /** Read reference bytes only through verified attachment references, bounded by the per-run media limit. */
  private async referenceImages(
    request: DirectRequest, signal: AbortSignal,
  ): Promise<{ references: ProviderImage[]; mask?: ProviderImage }> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new DirectAiError('DIRECT_AI_NOT_CONFIGURED', 'Durable image storage is unavailable; upload the reference image again.')
    }
    let bytes = 0
    const read = async (ref: ImageAttachmentRef): Promise<ProviderImage> => {
      signal.throwIfAborted()
      const stored = await attachments.readImage(ref, signal).catch((error: unknown) => {
        signal.throwIfAborted()
        if (error instanceof DirectAiError) throw error
        throw new DirectAiError('DIRECT_AI_INVALID_INPUT', 'A reference image is no longer available; upload it again.')
      })
      bytes += stored.data.byteLength
      if (bytes > this.config.maxMediaBytes) {
        throw new DirectAiError('DIRECT_AI_LIMIT', 'Reference images exceed the configured media byte limit.')
      }
      signal.throwIfAborted()
      return { bytes: stored.data, mime: stored.ref.mediaType, ...stored.ref.name === undefined ? {} : { name: stored.ref.name } }
    }
    const references: ProviderImage[] = []
    for (const ref of request.references ?? []) references.push(await read(ref))
    const mask = request.mask === undefined ? undefined : await read(request.mask)
    return { references, ...mask === undefined ? {} : { mask } }
  }

  private async writeMedia(
    domain: Domain<typeof directDomain>, runId: RunId, bytes: Uint8Array, mime: string, signal: AbortSignal,
  ): Promise<{ url: string; mime: string }> {
    signal.throwIfAborted()
    const id = randomUUID()
    const path = join(this.directory, id)
    const file = await open(path, 'wx', 0o600)
    try {
      try { await file.writeFile(bytes, { signal }) } finally { await file.close() }
      signal.throwIfAborted()
      const media = { id, runId, mime, size: bytes.length }
      await domain.table('media').put(id, directDomain.tables.media.valueSchema.parse(media))
    } catch (error) {
      await unlink(path)
      throw error
    }
    return { url: `api/direct-ai/media?id=${id}`, mime }
  }

  private async prune(domain: Domain<typeof directDomain>): Promise<void> {
    const settled = [...domain.table('runs').entries()].filter(([, run]) => run.status !== 'running').sort((a, b) => b[1].startedAt - a[1].startedAt)
    for (const [runId] of settled.slice(this.config.maxHistory)) {
      for (const [id, media] of domain.table('media').entries()) {
        if (media.runId !== runId) continue
        await domain.table('media').delete(id)
        try { await unlink(join(this.directory, id)) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await domain.table('runs').delete(runId)
    }
  }

  private async mediaResponse(request: Request): Promise<Response> {
    if (this.closed) return new Response('unavailable', { status: 503 })
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    if (id === null || !z.uuid().safeParse(id).success || [...url.searchParams.keys()].some(key => key !== 'id' && key !== 'download')) return new Response('not found', { status: 404 })
    try {
      const media = (await this.store()).table('media').get(id)
      if (media === undefined) return new Response('not found', { status: 404 })
      const file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW)
      let body: Uint8Array
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== media.size || stat.size > this.config.maxMediaBytes) return new Response('not found', { status: 404 })
        const headers: Record<string, string> = { 'content-type': media.mime, 'content-length': String(stat.size), 'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'accept-ranges': 'bytes',
          'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="direct-ai-${id}.${media.mime.split('/')[1]}"`,
        }
        if (request.method === 'HEAD') return new Response(null, { headers })
        const range = request.headers.get('range')
        if (range !== null) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          const first = match?.[1] ?? ''
          const last = match?.[2] ?? ''
          const start = first === '' ? Math.max(0, stat.size - Number(last)) : Number(first)
          const end = first === '' || last === '' ? stat.size - 1 : Math.min(stat.size - 1, Number(last))
          if (match === null || (first === '' && last === '') || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < 0 || start >= stat.size || end < start) {
            return new Response(null, { status: 416, headers: { ...headers, 'content-length': '0', 'content-range': `bytes */${stat.size}` } })
          }
          const value = Buffer.alloc(end - start + 1)
          let offset = 0
          while (offset < value.length) {
            request.signal.throwIfAborted()
            const read = await file.read(value, offset, value.length - offset, start + offset)
            if (read.bytesRead === 0) throw new DirectAiError('DIRECT_AI_STORAGE_FAILED', 'Private media was truncated.')
            offset += read.bytesRead
          }
          return new Response(value, { status: 206, headers: { ...headers, 'content-length': String(value.length), 'content-range': `bytes ${start}-${end}/${stat.size}` } })
        }
        body = await file.readFile({ signal: request.signal })
        return new Response(new Uint8Array(body).buffer, { headers })
      } finally { await file.close() }
    } catch (_mediaUnavailable) { return new Response('media unavailable', { status: 404 }) }
  }
}
