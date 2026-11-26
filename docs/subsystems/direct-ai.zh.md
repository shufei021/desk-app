# Direct AI

[English](direct-ai.md) | 中文

## 概述

Direct AI 独立于 Agent 和 Session 处理，发送经过 owner 身份验证的对话、生图及视频请求。本参考拥有其公开请求与结果类型以及生成的 `ctx.directAi` API；[包参考](../../packages/host/direct-ai/README.zh.md)拥有提供方协议、限制、凭据、持久化与失败行为。

## 类型

客户端安全的声明位于 [`types.ts`](../../packages/host/direct-ai/src/types.ts)。已保存服务的元数据选择显式能力与提供方端点；API key 仅由保存输入接收，不会通过视图或历史返回。

| 类型 | 用途 |
|---|---|
| <a id="directorysource"></a>`DirectorySource` | 固定无密钥公开目录、已保存服务，或显式草稿地址与密钥对。已保存密钥不能与调用者另填的地址组合。 |
| <a id="modeldirectory"></a>`ModelDirectory` | 模型标识、平台与分组注释，以及来源和时间。公开目录及分组不授予密钥权限，也不表示支持某种生成协议。 |
| <a id="generatedimageresult"></a>`GeneratedImageResult` | 可信 Host 生图结果，包含提供方运行 id、已保存服务身份及独立于直接历史媒体清理的持久附件引用。调用者拥有授权责任。 |
| <a id="serviceid"></a>`ServiceId` | 已保存提供方配置的品牌化标识。 |
| <a id="serviceinput"></a>`ServiceInput` | 服务元数据，包含可选的已有 id 及只写 API key 更新。省略 key 会保留它；空 key 会删除它。 |
| <a id="serviceview"></a>`ServiceView` | 已保存元数据、其 id 与凭据存在状态布尔值，不含 key 内容或脱敏预览。 |
| <a id="directrequest"></a>`DirectRequest` | 所选服务、完整文本消息、可选 JSON 参数，以及仅用于生图的参考图或 mask（均为已存附件引用）。可选 `displayPrompt` 是供提交方 UI 保留展示的文本，从不进入提供方输入。对话接受 system/user/assistant 消息；生图和视频要求单条用户提示词。 |
| <a id="directframe"></a>`DirectFrame` | 增量文本、进度、媒体或 done 更新。done 在持久成功后出现；失败或取消使流拒绝。 |
| <a id="runrecord"></a>`RunRecord` | 保留的请求，包含服务快照、时间戳、状态、部分或完整帧及可选安全错误。其品牌化 `RunId` 独立于 Session 标识记录。 |

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [DirectFrame](direct-ai.zh.md#directframe) · [DirectRequest](direct-ai.zh.md#directrequest) · [DirectorySource](direct-ai.zh.md#directorysource) · [GeneratedImageResult](direct-ai.zh.md#generatedimageresult) · [ImageAttachmentRef](attachment.zh.md) · [ModelDirectory](direct-ai.zh.md#modeldirectory) · [RunRecord](direct-ai.zh.md#runrecord) · [ServiceId](direct-ai.zh.md#serviceid) · [ServiceInput](direct-ai.zh.md#serviceinput) · [ServiceView](direct-ai.zh.md#serviceview)

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

Types: [Agent](core.zh.md) · [GeneratedImageResult](direct-ai.zh.md#generatedimageresult)

Source: [`packages/host/tool-image-generation/src/index.ts`](../../packages/host/tool-image-generation/src/index.ts)
<!-- END GENERATED cordis-surface -->
