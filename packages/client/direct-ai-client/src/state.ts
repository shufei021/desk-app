/** Direct-provider catalog and request state owned by one browser controller. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type {
  Capability, DirectorySource, ImageReference, ModelDirectory, DirectFrame, DirectMessage, DirectRequest, RunRecord,
  ServiceId, ServiceInput, ServiceView,
} from '@deepseek-ai/dsh-direct-ai/types'
import { imageParamFacts, type ImageParamFacts } from './image-param-facts.ts'

/** Authoritative catalog read and acknowledged mutation state. */
export interface CatalogState {
  phase: 'loading' | 'ready' | 'error'
  services: ServiceView[]
  mutation: 'idle' | 'saving' | 'removing'
  error?: 'loadError' | 'saveError' | 'removeError' | 'referenceUploadFailed'
}
/** Prompt and provenance facts the result card shows beside the generated images. */
export interface ShownRun {
  /** User-authored description retained with the Host request; absent when the request carried none. */
  displayPrompt?: string
  /** Service name captured at request time, retained after the service is deleted. */
  serviceName: string
  /** Model captured at request time, retained after the service or its model changes. */
  model: string
  /** Epoch milliseconds when the run started. */
  startedAt: number
  /** Reference images the run submitted. */
  referenceCount: number
  /** Size, quality and count the request carried; absent when it used provider defaults. */
  imageParams?: ImageParamFacts
}

/** This page's conversation and the current request's retained output. */
export interface InteractionState {
  serviceId: ServiceId | undefined
  messages: DirectMessage[]
  frames: DirectFrame[]
  phase: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  error?: 'requestError' | 'streamEnded'
  errorCode?: string
  /** Pairing facts of the run these frames belong to; absent before a run or after a reset. */
  run?: ShownRun
}
/** Host-retained request history, independent of a workspace or Agent Session. */
export interface HistoryState {
  phase: 'loading' | 'ready' | 'error'
  records: RunRecord[]
}

/** One explicitly requested model directory, separate from saved service configuration. */
export interface DirectoryState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  value: ModelDirectory | undefined
  error?: 'directoryError'
  errorCode?: string
}

/** Exact generated Remote dependency, supplied by the registration's context. */
export type DirectRemote = Pick<
  ClientRemote['directAi'], 'catalog' | 'save' | 'removeService' | 'run' | 'history' | 'discoverModels' | 'uploadReference'
>

/** Settlement of one prompt-assistant chat stream; failures never trigger a retry. */
export type AssistOutcome =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'failed'; errorCode?: string }

/**
 * Stream one prompt-assistant completion without touching the page's displayed run.
 * @param serviceId - configured chat service the user chose.
 * @param system - fixed assistant instruction sent as the system message.
 * @param prompt - current description, already non-empty.
 * @param onText - receives the accumulated answer after each text frame.
 * @param signal - cancels this stream only.
 * @returns whether the provider confirmed completion, the user cancelled, or it failed.
 */
export type AssistChat = (
  serviceId: ServiceId, system: string, prompt: string, onText: (text: string) => void, signal: AbortSignal,
) => Promise<AssistOutcome>

/** Canonical base64 data URL emitted by `FileReader`; only that prefix is removed. */
const DATA_URL_PREFIX = /^data:[^,]*;base64,/

function failureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * Read one browser file as its data URL without copying the bytes on the main thread.
 * @param file - user-selected file.
 * @returns the complete `FileReader` data URL.
 */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('direct-ai: reference read produced no data URL'))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => { reject(reader.error ?? new Error('direct-ai: reference read failed')) }
    reader.readAsDataURL(file)
  })
}

/**
 * Validate an optional parameter editor without coercing non-object JSON values.
 * @param text - user-authored JSON; blank means no overrides.
 * @returns whether the input is blank or a JSON object.
 */
export function validParameters(text: string): boolean {
  if (text.trim() === '') return true
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch (_invalidJson) {
    return false
  }
}

/**
 * Resolve only explicitly configured provider capabilities, without inferring from a key or model name.
 * @param services - Host-confirmed service views.
 * @returns capabilities in stable product order.
 */
export function configuredCapabilities(services: readonly ServiceView[]): Capability[] {
  return (['chat', 'image', 'video'] as const).filter(capability => services.some(service => service.configured && service.capability === capability))
}

/** Browser-owned requests never reconnect or retry automatically, avoiding duplicate charges. */
export class DirectController {
  /** Host-confirmed provider services and configuration mutation outcomes. */
  readonly catalog = createSnapshotStore<CatalogState>({ phase: 'loading', services: [], mutation: 'idle' })
  /** This page's explicit conversation and current request output. */
  readonly interaction = createSnapshotStore<InteractionState>({ serviceId: undefined, messages: [], frames: [], phase: 'idle' })
  /** Last successfully read Host request history and its query status. */
  readonly history = createSnapshotStore<HistoryState>({ phase: 'loading', records: [] })
  /** On-demand remote directory; draft keys are never retained in this source. */
  readonly directory = createSnapshotStore<DirectoryState>({ phase: 'idle', value: undefined })
  private directoryRequest: { controller: AbortController; settled: Promise<boolean> } | undefined
  private readonly directoryReads = new Set<Promise<boolean>>()
  private readonly lifetime = new AbortController()
  private execution: { controller: AbortController; settled: Promise<boolean> } | undefined
  private reading = 0

  /** @param remote - the generated direct AI namespace; it never receives an Agent context. */
  constructor(private readonly remote: DirectRemote) {}

  /**
   * Read configuration and history; an unsuccessful read retains previously visible data.
   * @returns once both reads settle; failures remain visible in their respective sources.
   */
  async refresh(): Promise<void> {
    if (this.isDisposed() || this.catalog.getSnapshot().mutation !== 'idle') return
    const ordinal = ++this.reading
    const [catalog, history] = await Promise.allSettled([this.remote.catalog(), this.remote.history()])
    if (this.isDisposed() || ordinal !== this.reading) return
    if (catalog.status === 'fulfilled' && catalog.value.ok) {
      const services = catalog.value.value
      this.catalog.set({ phase: 'ready', services, mutation: this.catalog.getSnapshot().mutation })
      const view = this.interaction.getSnapshot()
      if (view.phase === 'idle' && view.messages.length === 0 && !services.some(service => service.id === view.serviceId && service.configured)) {
        this.select(services.find(service => service.configured)?.id)
      }
    } else {
      this.catalog.set({ ...this.catalog.getSnapshot(), phase: 'error', error: 'loadError' })
    }
    this.history.set(history.status === 'fulfilled' && history.value.ok
      ? { phase: 'ready', records: history.value.value }
      : { ...this.history.getSnapshot(), phase: 'error' })
  }

  /**
   * Save an explicit service choice. The credential is sent once and never retained in this controller.
   * @param input - metadata plus an optional replacement key.
   * @returns true after acknowledgement; an uncertain save requires readback before retry.
   */
  async save(input: ServiceInput): Promise<boolean> {
    if (this.isDisposed() || this.catalog.getSnapshot().mutation !== 'idle') return false
    this.reading += 1
    const current = this.catalog.getSnapshot()
    this.catalog.set({ phase: current.phase, services: current.services, mutation: 'saving' })
    try {
      const result = await this.remote.save(input)
      if (this.isDisposed()) return false
      if (!result.ok) throw result.error
      const service = result.value
      const services = this.catalog.getSnapshot().services.filter(item => item.id !== service.id)
      this.catalog.set({ phase: 'ready', services: [...services, service], mutation: 'idle' })
      this.select(service.id)
      return true
    } catch (_saveFailed) {
      if (!this.isDisposed()) this.catalog.set({ ...this.catalog.getSnapshot(), mutation: 'idle', error: 'saveError' })
      return false
    }
  }

  /**
   * Remove a service only from its Host acknowledgement, leaving request history intact.
   * @param id - service selected for removal.
   * @returns whether removal was confirmed.
   */
  async remove(id: ServiceId): Promise<boolean> {
    if (this.isDisposed() || this.catalog.getSnapshot().mutation !== 'idle') return false
    this.reading += 1
    const current = this.catalog.getSnapshot()
    this.catalog.set({ phase: current.phase, services: current.services, mutation: 'removing' })
    try {
      const result = await this.remote.removeService(id)
      if (this.isDisposed()) return false
      if (!result.ok) throw result.error
      const services = this.catalog.getSnapshot().services.filter(service => service.id !== id)
      this.catalog.set({ phase: 'ready', services, mutation: 'idle' })
      if (this.interaction.getSnapshot().serviceId === id) this.select(services.find(service => service.configured)?.id)
      return true
    } catch (_removeFailed) {
      if (!this.isDisposed()) this.catalog.set({ ...this.catalog.getSnapshot(), mutation: 'idle', error: 'removeError' })
      return false
    }
  }

  /**
   * Change the page's service and reset conversation input; a running request cannot change service.
   * @param serviceId - saved service, or undefined when no configured service remains.
   */
  select(serviceId: ServiceId | undefined): void {
    const state = this.interaction.getSnapshot()
    if (state.phase === 'running' || state.serviceId === serviceId) return
    this.interaction.set({ serviceId, messages: [], frames: [], phase: 'idle' })
  }

  /** Start an empty conversation without deleting durable history. */
  clear(): void {
    const state = this.interaction.getSnapshot()
    if (state.phase === 'running') return
    this.interaction.set({ serviceId: state.serviceId, messages: [], frames: [], phase: 'idle' })
  }

  /**
   * Display a retained request without submitting or retrying it.
   * @param record - Host-confirmed historical request; the original service may have been deleted.
   */
  restore(record: RunRecord): void {
    if (this.interaction.getSnapshot().phase === 'running') return
    const imageParams = imageParamFacts(record.request.parametersJson)
    this.interaction.set({
      serviceId: record.service.id,
      messages: record.request.messages,
      frames: record.frames,
      phase: record.status === 'running' ? 'failed' : record.status,
      ...record.error === undefined ? {} : { error: 'requestError', errorCode: record.error.code },
      run: {
        ...record.request.displayPrompt === undefined ? {} : { displayPrompt: record.request.displayPrompt },
        serviceName: record.service.name, model: record.service.model, startedAt: record.startedAt,
        referenceCount: record.request.references?.length ?? 0,
        ...(imageParams === undefined ? {} : { imageParams }),
      },
    })
  }

  /**
   * Store one user-selected reference image through the Host attachment path.
   * The image bytes never enter this controller; the resolved durable reference is returned to the caller.
   * @param file - browser-selected raster image; its declared type and name are forwarded unchanged.
   * @returns the durable reference accepted by `submit`, or undefined after a failure shown in `catalog.error`.
   */
  async uploadReference(file: File): Promise<ImageReference | undefined> {
    if (this.isDisposed()) return undefined
    this.clearReferenceFailure()
    try {
      const dataUrl = await readDataUrl(file)
      if (this.isDisposed()) return undefined
      const prefix = DATA_URL_PREFIX.exec(dataUrl)
      if (prefix === null) throw new Error('direct-ai: reference read produced no base64 data URL')
      const result = await this.remote.uploadReference(
        { data: dataUrl.slice(prefix[0].length), mime: file.type, name: file.name }, this.lifetime.signal,
      )
      if (this.isDisposed()) return undefined
      if (!result.ok) throw result.error
      return result.value
    } catch (_uploadFailed) {
      if (!this.isDisposed()) this.catalog.set({ ...this.catalog.getSnapshot(), error: 'referenceUploadFailed' })
      return undefined
    }
  }

  /**
   * Submit exactly the user's messages and optional system text once; partial outputs remain after failure.
   * @param prompt - user input; empty input is refused locally.
   * @param system - explicit chat-only system message, omitted when blank.
   * @param parametersJson - explicit per-request JSON parameters, omitted when blank.
   * @param references - image-only durable reference images, omitted when empty.
   * @param mask - image-only durable edit mask, omitted when absent.
   * @param displayPrompt - user-authored description retained for paired prompt/result display, omitted when blank.
   *   It never becomes provider input; only `messages` reaches the provider.
   * @returns whether a durable completion frame was received.
   */
  async submit(
    prompt: string, system: string, parametersJson: string,
    references?: readonly ImageReference[], mask?: ImageReference, displayPrompt?: string,
  ): Promise<boolean> {
    if (this.isDisposed() || this.execution !== undefined || !prompt.trim() || !validParameters(parametersJson)) return false
    const state = this.interaction.getSnapshot()
    const service = this.catalog.getSnapshot().services.find(item => item.id === state.serviceId && item.configured)
    if (service === undefined) return false
    const messages: DirectMessage[] = []
    if (service.capability === 'chat') {
      if (system.trim()) messages.push({ role: 'system', content: system })
      const previous = state.messages.filter(message => message.role !== 'system')
      if ((state.phase === 'failed' || state.phase === 'cancelled') && previous.at(-1)?.role === 'user') previous.pop()
      messages.push(...previous)
      if (state.phase === 'completed') {
        const text = state.frames.filter(frame => frame.type === 'text').map(frame => frame.text).join('')
        if (text) messages.push({ role: 'assistant', content: text })
      }
    }
    messages.push({ role: 'user', content: prompt })
    const shownPrompt = displayPrompt?.trim()
    const shownParams = imageParamFacts(parametersJson)
    const request: DirectRequest = {
      serviceId: service.id,
      messages,
      ...(parametersJson.trim() ? { parametersJson } : {}),
      ...(shownPrompt ? { displayPrompt: shownPrompt } : {}),
      ...(references !== undefined && references.length > 0 ? { references: [...references] } : {}),
      ...(mask === undefined ? {} : { mask }),
    }
    const controller = new AbortController()
    this.interaction.set({
      serviceId: service.id, messages, frames: [], phase: 'running',
      run: {
        ...(shownPrompt ? { displayPrompt: shownPrompt } : {}),
        serviceName: service.name, model: service.model, startedAt: Date.now(), referenceCount: references?.length ?? 0,
        ...(shownParams === undefined ? {} : { imageParams: shownParams }),
      },
    })
    const settled = this.execute(request, controller)
    this.execution = { controller, settled }
    try { return await settled }
    finally {
      this.execution = undefined
      if (!this.isDisposed()) await this.refresh()
    }
  }

  /**
   * Stream one chat completion for the prompt assistant without entering this controller's conversation.
   * The image workspace's displayed run, its parameters and its retained history stay untouched.
   * @param serviceId - configured chat service chosen in the assistant panel.
   * @param system - fixed assistant instruction; blank omits the system message.
   * @param prompt - description to expand; blank input is refused locally.
   * @param onText - receives the accumulated answer after each text frame.
   * @param signal - caller-owned cancellation for this stream only.
   * @returns the stream settlement; a failure carries the provider error code when present.
   */
  async assistChat(
    serviceId: ServiceId, system: string, prompt: string,
    onText: (text: string) => void, signal: AbortSignal,
  ): Promise<AssistOutcome> {
    if (this.isDisposed() || !prompt.trim()) return { status: 'failed' }
    const service = this.catalog.getSnapshot().services.find(item =>
      item.id === serviceId && item.configured && item.capability === 'chat')
    if (service === undefined) return { status: 'failed' }
    const messages: DirectMessage[] = []
    if (system.trim()) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })
    const request: DirectRequest = { serviceId: service.id, messages }
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    let completed = false
    let text = ''
    try {
      const stream = this.remote.run(request, lifetime)
      try {
        for await (const frame of stream) {
          if (lifetime.aborted) break
          if (frame.type === 'text') {
            text += frame.text
            onText(text)
          }
          completed ||= frame.type === 'done'
        }
      } finally { stream.dispose() }
      if (signal.aborted || this.isDisposed()) return { status: 'cancelled' }
      return completed ? { status: 'completed' } : { status: 'failed' }
    } catch (error) {
      if (signal.aborted || this.isDisposed()) return { status: 'cancelled' }
      const errorCode = failureCode(error)
      return { status: 'failed', ...(errorCode === undefined ? {} : { errorCode }) }
    }
  }

  /**
   * Open one streaming direct request without entering this controller's displayed run or history.
   * The image workspace's variant batch owns the returned stream and disposes it after iteration.
   * @param request - exact provider request to stream.
   * @param signal - caller-owned cancellation for this stream only.
   * @returns the open stream handle, linked to this controller's lifetime.
   */
  openStream(request: DirectRequest, signal: AbortSignal): RemoteStreamHandle<DirectFrame, never> {
    return this.remote.run(request, AbortSignal.any([signal, this.lifetime.signal]))
  }

  /**
   * Read one explicitly selected directory without saving credentials or invoking a model.
   * @param source - fixed public catalog, a saved service, or a URL with its own explicit draft key.
   * @returns whether this request published a successful directory before it was superseded.
   */
  async discoverModels(source: DirectorySource): Promise<boolean> {
    if (this.isDisposed()) return false
    this.clearDirectory()
    const controller = new AbortController()
    const owned = { controller, settled: Promise.resolve(false) }
    this.directoryRequest = owned
    this.directory.set({ phase: 'loading', value: undefined })
    owned.settled = this.readDirectory(source, owned)
    this.directoryReads.add(owned.settled)
    try { return await owned.settled }
    finally { this.directoryReads.delete(owned.settled) }
  }

  /** Cancel any stale editor lookup and release its displayed identifiers. */
  clearDirectory(): void {
    this.directoryRequest?.controller.abort()
    this.directoryRequest = undefined
    this.directory.set({ phase: 'idle', value: undefined })
  }

  private async readDirectory(
    source: DirectorySource, owned: { controller: AbortController; settled: Promise<boolean> },
  ): Promise<boolean> {
    try {
      const result = await this.remote.discoverModels(source, AbortSignal.any([owned.controller.signal, this.lifetime.signal]))
      if (owned.controller.signal.aborted || this.isDisposed() || this.directoryRequest !== owned) return false
      if (!result.ok) throw result.error
      this.directory.set({ phase: 'ready', value: result.value })
      return true
    } catch (error) {
      if (owned.controller.signal.aborted || this.isDisposed() || this.directoryRequest !== owned) return false
      const code = failureCode(error)
      this.directory.set({ phase: 'error', value: undefined, error: 'directoryError', ...(code === undefined ? {} : { errorCode: code }) })
      return false
    } finally {
      if (this.directoryRequest === owned) this.directoryRequest = undefined
    }
  }

  /** Stop local waiting; an already accepted provider job may continue and incur charges. */
  stop(): void { this.execution?.controller.abort() }

  /**
   * Cancel and join any request before the generated Remote contribution is withdrawn.
   * @returns after all active stream consumption has settled.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.reading += 1
    this.clearDirectory()
    this.execution?.controller.abort()
    await Promise.all([this.execution?.settled, ...this.directoryReads])
  }

  private isDisposed(): boolean { return this.lifetime.signal.aborted }

  /** Drop a previous reference-upload failure before another attempt, keeping other catalog errors. */
  private clearReferenceFailure(): void {
    const state = this.catalog.getSnapshot()
    if (state.error !== 'referenceUploadFailed') return
    this.catalog.set({ phase: state.phase, services: state.services, mutation: state.mutation })
  }

  private async execute(request: DirectRequest, controller: AbortController): Promise<boolean> {
    let completed = false
    try {
      const stream = this.remote.run(request, AbortSignal.any([controller.signal, this.lifetime.signal]))
      try {
        for await (const frame of stream) {
          if (controller.signal.aborted || this.isDisposed()) break
          completed ||= frame.type === 'done'
          const current = this.interaction.getSnapshot()
          this.interaction.set({ ...current, frames: [...current.frames, frame] })
        }
      } finally { stream.dispose() }
      if (this.isDisposed()) return false
      const cancelled = controller.signal.aborted
      this.interaction.set({
        ...this.interaction.getSnapshot(),
        phase: cancelled ? 'cancelled' : completed ? 'completed' : 'failed',
        ...cancelled || completed ? {} : { error: 'streamEnded' },
      })
      return completed && !cancelled
    } catch (error) {
      if (this.isDisposed()) return false
      const errorCode = failureCode(error)
      this.interaction.set({
        ...this.interaction.getSnapshot(),
        phase: controller.signal.aborted ? 'cancelled' : 'failed',
        ...controller.signal.aborted ? {} : { error: 'requestError', ...(errorCode === undefined ? {} : { errorCode }) },
      })
      return false
    }
  }
}
