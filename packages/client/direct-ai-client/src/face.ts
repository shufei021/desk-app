/**
 * Controller face shared by the Direct AI page and the image workspace: the
 * controller's observable sources, its one-request actions, and the mapping
 * from a page-owned controller to the inject compartment of a main panel.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DirectorySource, ImageReference, RunRecord, ServiceId, ServiceInput,
} from '@deepseek-ai/dsh-direct-ai/types'
import type {
  CatalogState, DirectoryState, DirectController, HistoryState, InteractionState,
} from './state.ts'

/** Narrow controller actions and framework-bound sources; no Agent or workspace is required. */
export interface DirectPageInjected {
  hooks: {
    catalog: HostObservable<CatalogState>
    interaction: HostObservable<InteractionState>
    history: HostObservable<HistoryState>
    directory: HostObservable<DirectoryState>
  }
  /**
   * Replace the transient model directory, cancelling any previous read.
   * @param source - public listing or an explicit saved/draft credential scope.
   * @returns whether a result was confirmed; failures remain in the directory source.
   */
  discoverModels(this: void, source: DirectorySource): Promise<boolean>
  /** Abort directory discovery and release its transient data. */
  clearDirectory(this: void): void
  /**
   * Reload configuration and history, retaining visible data on failure.
   * @returns after both reads settle; their failures remain in their respective sources.
   */
  refresh(this: void): Promise<void>
  /**
   * Save a service once without caching its credential.
   * @param input - explicit metadata and optional replacement key; omission preserves the saved key.
   * @returns whether mutation was confirmed; false requires readback before retry.
   */
  save(this: void, input: ServiceInput): Promise<boolean>
  /**
   * Remove a service only on acknowledgement, retaining request history.
   * @param id - service selected in the confirmation dialog.
   * @returns whether deletion was confirmed; false requires readback before retry.
   */
  remove(this: void, id: ServiceId): Promise<boolean>
  /**
   * Select a configured service and reset its displayed conversation.
   * @param serviceId - saved service identity; selection is refused during a running request.
   */
  select(this: void, serviceId: ServiceId): void
  /**
   * Store one selected reference image for a later image request.
   * @param file - browser-selected raster image; its declared type and name are forwarded unchanged.
   * @returns the durable reference accepted by `submit`, or undefined after a failure visible in the catalog source.
   */
  uploadReference(this: void, file: File): Promise<ImageReference | undefined>
  /**
   * Submit once; completion, partial output and failures remain controller-owned.
   * @param prompt - explicit user message or generation prompt.
   * @param system - chat-only system text; blank omits the system message.
   * @param parametersJson - per-request JSON object; blank omits overrides.
   * @param references - image-only durable reference images; empty or absent omits the field.
   * @param mask - image-only durable edit mask; absent omits the field.
   * @param displayPrompt - user-authored description retained for paired display; blank or absent omits it.
   *   The provider request never carries it.
   * @returns whether a durable completion was confirmed; false does not trigger a retry.
   */
  submit(
    this: void, prompt: string, system: string, parametersJson: string, references?: readonly ImageReference[],
    mask?: ImageReference, displayPrompt?: string,
  ): Promise<boolean>
  /** Stop local waiting without promising provider-side cancellation or refunds. */
  stop(this: void): void
  /** Reset the displayed conversation without deleting retained history. */
  clear(this: void): void
  /**
   * Display a retained request without replaying it.
   * @param run - historical inputs and results; its original service may have been deleted.
   */
  restore(this: void, run: RunRecord): void
  /** Return to the Agent page without stopping a running direct request. */
  backToAgent(this: void): void
}

/**
 * Build the controller face shared by both pages; selection can persist the chosen service.
 * @param controller - page-owned controller instance.
 * @param backToAgent - returns to the Agent page from this plugin's main panel.
 * @param select - selection handler, defaulting to the controller's own selection.
 * @returns the injected data and callbacks for one main panel.
 */
export function pageFace(
  controller: DirectController, backToAgent: () => void,
  select: (serviceId: ServiceId) => void = (serviceId) => { controller.select(serviceId) },
): DirectPageInjected {
  return {
    hooks: {
      catalog: controller.catalog, interaction: controller.interaction,
      history: controller.history, directory: controller.directory,
    },
    refresh: () => controller.refresh(),
    discoverModels: source => controller.discoverModels(source),
    clearDirectory: () => { controller.clearDirectory() },
    save: input => controller.save(input),
    remove: id => controller.remove(id),
    select,
    submit: (prompt, system, parameters, references, mask, displayPrompt) =>
      controller.submit(prompt, system, parameters, references, mask, displayPrompt),
    uploadReference: file => controller.uploadReference(file),
    stop: () => { controller.stop() },
    clear: () => { controller.clear() },
    restore: (record) => { controller.restore(record) },
    backToAgent,
  }
}
