/** One controller owns catalog reads and non-atomic service/default writes without retaining keys. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ServiceInput, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'

/** Only the selected service id is persisted; an empty value disables generation. */
export interface ImageGenerationSettings { defaultServiceId: string }
/** Catalog and mutation outcomes; credential contents never enter observable state. */
export interface ImageSettingsState {
  phase: 'loading' | 'ready' | 'error'
  services: ServiceView[]
  mutation: 'idle' | 'saving' | 'selecting'
  error?: 'loadError' | 'saveError' | 'partialSave' | 'defaultError'
}
/** Exact generated API operations consumed by this editor. */
export type ImageSettingsRemote = {
  directAi: Pick<ClientRemote['directAi'], 'catalog' | 'save'>
  settings: Pick<ClientRemote['settings'], 'update'>
}

/** Readable data survives query failure; writes require explicit readback after an unknown outcome. */
export class ImageSettingsController {
  /** Non-secret configuration reads and acknowledged or uncertain write outcomes. */
  readonly state = createSnapshotStore<ImageSettingsState>({ phase: 'loading', services: [], mutation: 'idle' })
  private closed = false
  private reading = 0
  private readonly pending = new Set<Promise<unknown>>()

  /** @param remote - generated namespaces. @param form - authoritative configuration snapshot. */
  constructor(private readonly remote: ImageSettingsRemote, private readonly form: ConfigForm<ImageGenerationSettings>) {}

  /** Reload services without changing defaults. @returns after the latest result is published or discarded. */
  async refresh(): Promise<void> {
    if (this.closed || this.state.getSnapshot().mutation !== 'idle') return
    const ordinal = ++this.reading
    const operation = this.load(ordinal)
    this.pending.add(operation)
    try { await operation } finally { this.pending.delete(operation) }
  }

  private async load(ordinal: number): Promise<void> {
    try {
      const result = await this.remote.directAi.catalog()
      if (this.closed || ordinal !== this.reading) return
      if (!result.ok) throw result.error
      this.state.set({ phase: 'ready', services: result.value, mutation: 'idle' })
    } catch (_readFailed) {
      if (!this.closed && ordinal === this.reading) this.state.set({ ...this.state.getSnapshot(), phase: 'error', error: 'loadError' })
    }
  }

  /** Persist one configured image service or disable generation.
   * @param id - saved service identity, or an empty string for off.
   * @returns whether the default write was acknowledged.
   */
  async choose(id: string): Promise<boolean> {
    const before = this.state.getSnapshot()
    const settings = this.form.getSnapshot()
    if (this.closed || before.mutation !== 'idle' || before.phase !== 'ready' || before.error !== undefined
      || settings.status !== 'ready' || !settings.writable || settings.value === undefined) return false
    if (id !== '' && !before.services.some(service => service.id === id && service.configured && service.capability === 'image')) return false
    this.reading += 1
    this.state.set({ phase: before.phase, services: before.services, mutation: 'selecting' })
    const operation = this.writeDefault(id, settings.revision)
    this.pending.add(operation)
    try {
      const accepted = await operation
      if (!this.isClosed()) this.state.set({ ...this.state.getSnapshot(), mutation: 'idle', ...accepted ? {} : { error: 'defaultError' } })
      return accepted
    } finally { this.pending.delete(operation) }
  }

  private async writeDefault(id: string, revision: number | undefined): Promise<boolean> {
    try {
      const result = await this.remote.settings.update('image-generation', { defaultServiceId: id }, revision)
      return result.ok
    } catch (_writeNotConfirmed) { return false }
  }

  /** Save once, then select its id with the captured revision.
   * @param input - explicit new image configuration and write-only key.
   * @returns true only when both writes were acknowledged; a partial save remains visible and must not be blindly retried.
   */
  async save(input: ServiceInput): Promise<boolean> {
    const before = this.state.getSnapshot()
    const settings = this.form.getSnapshot()
    if (this.closed || before.mutation !== 'idle' || before.phase !== 'ready' || before.error !== undefined
      || settings.status !== 'ready' || !settings.writable || settings.value === undefined) return false
    if (input.capability !== 'image') return false
    this.reading += 1
    this.state.set({ phase: before.phase, services: before.services, mutation: 'saving' })
    const operation = this.saveAndSelect(input, settings.revision)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }

  private async saveAndSelect(input: ServiceInput, revision: number | undefined): Promise<boolean> {
    let saved: ServiceView
    try {
      const result = await this.remote.directAi.save(input)
      if (!result.ok) throw result.error
      saved = result.value
    } catch (_saveNotConfirmed) {
      if (!this.isClosed()) this.state.set({ ...this.state.getSnapshot(), mutation: 'idle', error: 'saveError' })
      return false
    }
    if (this.closed) return false
    const services = [...this.state.getSnapshot().services.filter(item => item.id !== saved.id), saved]
    this.state.set({ phase: 'ready', services, mutation: 'saving' })
    const accepted = await this.writeDefault(saved.id, revision)
    if (!this.isClosed()) this.state.set({ phase: 'ready', services, mutation: 'idle', ...accepted ? {} : { error: 'partialSave' } })
    return accepted
  }

  private isClosed(): boolean { return this.closed }

  /** Stop publication and join outstanding generated RPC promises. @returns after every owned call settles. */
  async dispose(): Promise<void> {
    this.closed = true
    this.reading += 1
    await Promise.allSettled([...this.pending])
  }
}
