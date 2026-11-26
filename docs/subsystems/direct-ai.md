# Direct AI

English | [中文](direct-ai.zh.md)

## Summary

Direct AI sends owner-authenticated chat, image and video requests independently of Agent and Session processing. This reference owns its public request and result types and generated `ctx.directAi` API; the [package reference](../../packages/host/direct-ai/README.md) owns provider protocols, limits, credentials, persistence and failure behavior.

## Types

The client-safe declarations live in [`types.ts`](../../packages/host/direct-ai/src/types.ts). Saved service metadata selects an explicit capability and provider endpoint; an API key is accepted only by the save input, not returned in views or history.

| Type | Purpose |
|---|---|
| <a id="directorysource"></a>`DirectorySource` | Fixed keyless public catalog, a saved service, or an explicit draft URL/key pair. A saved key cannot be combined with a caller-supplied URL. |
| <a id="modeldirectory"></a>`ModelDirectory` | Model identifiers, platform/group annotations and source/time facts. Neither the public listing nor its groups grant key entitlement or imply a generation protocol. |
| <a id="generatedimageresult"></a>`GeneratedImageResult` | Trusted Host image result with provider run id, saved service identity and durable attachment references independent of direct-history media retention. The caller owns authorization. |
| <a id="serviceid"></a>`ServiceId` | Branded identity of a saved provider configuration. |
| <a id="serviceinput"></a>`ServiceInput` | Service metadata with an optional existing id and write-only API key update. Omitting the key preserves it; an empty key removes it. |
| <a id="serviceview"></a>`ServiceView` | Saved metadata, its id and credential-presence boolean, without key contents or a masked preview. |
| <a id="directrequest"></a>`DirectRequest` | Selected service, complete textual messages, optional JSON parameters, and image-only reference images or a mask as already stored attachment references. An optional `displayPrompt` is retained display text for the submitting UI and never provider input. Chat accepts system/user/assistant messages; image and video require one user prompt. |
| <a id="directframe"></a>`DirectFrame` | Incremental text, progress, media or done update. Done follows durable success; failure or cancellation rejects the stream. |
| <a id="runrecord"></a>`RunRecord` | Retained request with a service snapshot, timestamps, status, partial or complete frames and an optional safe error. Its branded `RunId` identifies the record independently of a Session. |

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectai--directai"></a>

### `ctx.directAi` — `DirectAi`

Personal provider configuration, durable inference and image attachments, and owner-authenticated private media.

```ts cordis-catalog
/** Read saved non-secret services; a new home returns an empty list.
 * @returns saved metadata and credential presence, never credential contents.
 */
@Remote async catalog(): Promise<ServiceView[]>

/** Save metadata and optionally replace or remove its separately stored credential.
 * @param input - omitted apiKey preserves its current value; empty apiKey removes it.
 * @returns committed service metadata and current credential presence.
 */
@Remote async save(input: ServiceInput): Promise<ServiceView>

/** Remove a service and its credential; existing runs and history retain their non-secret snapshots.
 * @param id - opaque saved service identifier.
 */
@Remote async removeService(id: ServiceId): Promise<void>

/** Return full retained direct-request records, independent of Session logs.
 * @returns newest-first complete inputs and settled/partial outputs, without credentials.
 */
@Remote async history(): Promise<RunRecord[]>

/** Store one owner-selected reference image and return its durable attachment reference.
 * The returned reference is accepted unchanged by `DirectRequest.references` or `DirectRequest.mask`;
 * image bytes live only in attachment storage and never in a direct request record.
 * @param input - canonical base64 without a data prefix, declared raster media type, and optional display name.
 * @param signal - cancellation from the editor or Remote transport.
 * @returns durable attachment reference for the normalized stored image.
 */
@Remote async uploadReference(input: { data: string; mime: string; name?: string }, signal: AbortSignal): Promise<ImageAttachmentRef>

/** Read an explicit provider or public directory without invoking a model or changing an account group.
 * @param source - public listing, saved service, or a draft URL paired with its own explicit key.
 * @param signal - cancellation from the editor or Remote transport.
 * @returns provider-supplied identifiers and annotations, never a claim of key entitlement or model capability.
 */
@Remote async discoverModels(source: DirectorySource, signal: AbortSignal): Promise<ModelDirectory>

/** Generate durable images for an authorized trusted Host consumer; this is not a Remote operation.
 * Callers own authorization of the user or Session that may spend the saved service's credential.
 * @param serviceId - existing image service; callers cannot override its URL, model, key or parameters.
 * @param prompt - complete generation instruction retained before HTTP submission.
 * @param signal - consumer-owned cancellation; submitted provider work may still incur charges.
 * @returns attachment references only after direct-history completion is durable; no request is retried.
 */
async generateImage(serviceId: ServiceId, prompt: string, signal: AbortSignal): Promise<GeneratedImageResult>

/** Submit one non-retrying request and stream validated results. Closing the iterable cancels HTTP and polling.
 * @param request - complete textual input and optional parameter overrides; no tool fields are accepted.
 * @param signal - cancellation from the caller or Remote transport.
 * @returns incremental frames; done follows durable success, and failure/cancellation rejects after durable settlement.
 */
@Remote({ mode: 'stream' }) async *run(request: DirectRequest, signal: AbortSignal): AsyncIterable<DirectFrame>
```

Types: [DirectFrame](direct-ai.md#directframe) · [DirectRequest](direct-ai.md#directrequest) · [DirectorySource](direct-ai.md#directorysource) · [GeneratedImageResult](direct-ai.md#generatedimageresult) · [ImageAttachmentRef](attachment.md) · [ModelDirectory](direct-ai.md#modeldirectory) · [RunRecord](direct-ai.md#runrecord) · [ServiceId](direct-ai.md#serviceid) · [ServiceInput](direct-ai.md#serviceinput) · [ServiceView](direct-ai.md#serviceview)

Source: [`packages/host/direct-ai/src/index.ts`](../../packages/host/direct-ai/src/index.ts)

<a id="ctximagegeneration--imagegeneration"></a>

### `ctx.imageGeneration` — `ImageGeneration`

Trusted Host service; browser clients change its reference through owner-authenticated Settings only.

```ts cordis-catalog
/**
 * Generate once using the current explicit service after rechecking the exact live owner-driven turn.
 * @param agent - Agent supplied by the tool executor, never a caller-selected Session id.
 * @param prompt - Image description; no credentials, route or arbitrary provider arguments are accepted.
 * @param signal - Tool cancellation; local cancellation cannot undo upstream billing.
 * @returns Independently retained image attachments and the provider-history correlation id.
 */
async generate(agent: Agent, prompt: string, signal: AbortSignal): Promise<GeneratedImageResult>
```

Types: [Agent](core.md) · [GeneratedImageResult](direct-ai.md#generatedimageresult)

Source: [`packages/host/tool-image-generation/src/index.ts`](../../packages/host/tool-image-generation/src/index.ts)
<!-- END GENERATED cordis-surface -->
