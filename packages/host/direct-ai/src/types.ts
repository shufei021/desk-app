/** Client-safe types for owner-only direct provider requests, independent of Agent and Session. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'

/** Opaque saved provider configuration identifier. */
export type ServiceId = Branded<'DirectAiServiceId'>
/** Opaque durable direct-request identifier. */
export type RunId = Branded<'DirectAiRunId'>
/** Supported first-version provider protocols. */
export type Capability = 'chat' | 'image' | 'video'
/** One textual provider message; tools and attachments are not supported. */
export interface DirectMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
/** Saved provider metadata. Endpoint is a same-origin path relative to baseURL. */
export interface ServiceMetadata {
  name: string
  capability: Capability
  baseURL: string
  model: string
  endpoint?: string
  /** Same-origin image-edit path; omission replaces a final `generations` segment with `edits`, else uses `images/edits`. */
  editEndpoint?: string
  parametersJson?: string
  /** Display/filter annotation; it never selects a provider route. */
  platform?: string
  /** Public catalog group identity; the API key still determines the provider's actual group. */
  groupId?: number
  /** Display/filter annotation retained with the explicit service selection. */
  groupName?: string
}

/** One public catalog group, not a grant or a client-selectable billing route. */
export interface DirectoryGroup {
  id: number
  name: string
  platform: string
  description: string
}
/** A model identifier and provider-supplied display annotations; capability is deliberately not inferred. */
export interface DirectoryModel {
  id: string
  platform: string
  groupId?: number
  groupName?: string
}
/** Exact source of a directory read; saved credentials cannot be redirected by a draft URL. */
export type DirectorySource =
  | { kind: 'aiyoyoo-public' }
  | { kind: 'saved'; serviceId: ServiceId }
  | { kind: 'draft'; baseURL: string; apiKey: string }
/** Directory result records its scope; the public listing does not establish key entitlements. */
export interface ModelDirectory {
  source: 'aiyoyoo-public' | 'provider'
  models: DirectoryModel[]
  groups: DirectoryGroup[]
  fetchedAt: number
}

/** A service update. Omitted apiKey preserves its credential; an empty value removes it. */
export interface ServiceInput extends ServiceMetadata {
  id?: ServiceId
  apiKey?: string
}
/** Browser-visible configuration; credentials never appear, including masked previews. */
export interface ServiceView extends ServiceMetadata {
  id: ServiceId
  configured: boolean
}
/** Owner-selected reference image already stored as a durable attachment. */
export type ImageReference = ImageAttachmentRef

/** Full text input; image/video use the last user message as the prompt and reject other messages. */
export interface DirectRequest {
  serviceId: ServiceId
  messages: DirectMessage[]
  parametersJson?: string
  /**
   * UI-facing original description retained with the request so a result can show it beside the image.
   * It is owned by the requesting UI and never sent to the provider: provider bodies derive from
   * `messages` and admitted parameters only.
   */
  displayPrompt?: string
  /** Image capability only: reference images submitted through `images/edits`, in prompt order. */
  references?: ImageReference[]
  /** Image capability only: optional PNG mask whose transparent pixels mark editable areas. */
  mask?: ImageReference
}
/** Streaming direct-request updates. A done frame is emitted only after durable success. */
export type DirectFrame =
  | { type: 'text'; text: string }
  | { type: 'progress'; status: string; progress?: number }
  | { type: 'media'; url: string; mime: string }
  | { type: 'done' }
/** Durable image result for trusted Host consumers; attachments outlive direct-history media eviction. */
export interface GeneratedImageResult {
  runId: RunId
  service: { id: ServiceId; name: string; model: string }
  images: ImageAttachmentRef[]
}

/** One retained direct request, including complete non-credential input and partial results. */
export interface RunRecord {
  id: RunId
  service: ServiceMetadata & { id: ServiceId }
  request: DirectRequest
  startedAt: number
  finishedAt?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  frames: DirectFrame[]
  error?: { code: string; message: string }
}
