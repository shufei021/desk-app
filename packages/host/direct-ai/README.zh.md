---
description: "通过私有凭据、有限响应和独立请求历史，发送仅供所有者使用的直接聊天、图片和视频请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-direct-ai

[English](README.md) | 中文

## 概述

直接向已配置的提供方发送文本，不启动 Agent 或 Session。流式读取聊天文本、生成图片，或提交并轮询 OpenAI Sora 风格的视频任务。提供方元数据与 API key 分开保存；完整请求输入和结果可从私有历史恢复，生成媒体通过经过身份验证的仅限所有者 URL 查看。请求从不重试，因为连接失败时计费结果可能未知。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 credentials、storage-domain 和 Connection 旁挂载此服务；浏览器消费者使用生成的 `directAi` Remote 命名空间。

### 提供方协议

聊天使用 OpenAI Chat Completions、`stream: true` 和 SSE。图片使用 JSON `images/generations`，响应包含规范 `b64_json` 或不携带 Authorization 下载的 HTTP(S) URL。携带已存参考图的图片请求改用 multipart `images/edits`：`model`、`prompt`、按请求顺序每张参考图一个 `image` part、可选的 `mask` part，以及作为表单字段的获准参数；其响应按生成响应完全相同地解析。视频使用 multipart `POST videos`、状态 `GET videos/{id}`，完成后读取 `GET videos/{id}/content`。这些是特定协议，不表示兼容任意图片或视频厂商。

服务要求非空名称、模型及显式基础 URL。除 loopback 外必须使用 HTTPS；禁止用户信息、查询和片段。可选 endpoint 是同 origin 相对或绝对路径，不允许查询或片段。省略 endpoint 时，在基础 URL 下解析为 `chat/completions`、`images/generations` 或 `videos`。可选 `editEndpoint` 遵守同样规则：缺省时把生成路径末段 `generations` 换成 `edits`，否则使用 `images/edits`。JSON 参数对象可添加普通模型参数，但不得覆盖 model/messages/prompt/image/mask/stream、提供凭据或启用工具，包括嵌套工具字段。

聊天发送所有给定的 system/user/assistant 消息。图片和视频必须恰好包含一条非空 user 消息；其余消息会被拒绝，不会悄悄丢弃。可选 `displayPrompt` 记录用户自己的描述，供提交方 UI 在结果旁展示；提供方请求体只由 `messages` 和获准参数构造。每个获准提供方请求在 HTTP 派发前保存完整的无凭据输入及服务快照，再保存成功、失败或取消及部分输出。无效输入、服务不存在和并发限额拒绝不会启动提供方请求。

### 可信图片生成

`generateImage(serviceId, prompt, signal)` 是非 Remote 的 Host 方法，调用方必须独立授权使用已保存图片服务的凭据计费。它不接受调用者覆盖地址、模型、密钥或参数。图片存储缺失、服务非生图或凭据未配置时，在 HTTP 提交前拒绝。它共用现有串行服务与凭据快照、并发上限、取消、时限和持久直接请求历史；关闭等待完整操作结束。生成字节还会存入 `attachments`，返回的 `GeneratedImageResult` 引用在直接历史媒体清理后仍可读取。只有完成记录持久成功后才返回成功。存储或附件失败可能发生于已计费请求之后，绝不触发重试。Remote 的目录、修改、历史、模型读取及直接执行仍仅限 owner。

### 参考图编辑

`uploadReference({ data, mime, name? }, signal)` 是仅限 owner 的 Remote，把一张规范 base64 的 PNG/JPEG/WebP/GIF（不超过 `maxMediaBytes`）存入 `attachments`，返回可直接放入 `DirectRequest.references` 或 `DirectRequest.mask` 的持久引用。请求最多接受 8 张参考图和 1 张 mask；chat 或 video 服务携带参考图会被拒绝。`run` 在 HTTP 派发前通过附件存储逐张读取，引用不可读时报 `DIRECT_AI_INVALID_INPUT` 且不派发。请求记录只保存引用、不保存图像字节，因此直接历史保持很小，像素由附件库持有。参考图读取与编辑响应共享每次请求的 `maxMediaBytes` 限额。`editEndpoint` 选择编辑路径；缺省时末段 `generations` 变为 `edits`，否则回落到 `images/edits`。

### 模型目录

`discoverModels` 读取固定无密钥的 [CrazyToken 公开目录](https://www.aiyoyoo.com/api/v1/llm-pricing/models)、已保存服务基础地址下的 `models`（使用原子读取的凭据），或与显式草稿密钥配对的草稿地址。它拒绝重定向、无效 JSON、重复标识、凭据回显，以及超限原始或投影输出。读取共用请求时限、并发容量和关闭取消，但不调用模型、不修改账号分组，也不加入推理历史。平台、`groupId` 和 `groupName` 注释只供展示筛选，不作为路由参数发送。公开目录不含密钥权限或协议能力声明；平台首页说明兼容 OpenAI 对话，图片和视频协议仍需单独验证。

`direct_ai` 存储写入版本 2，并接受缺少注释的版本 1 记录。打开旧记录不重写它们，后续编辑才使用新版本。写入注释或编辑端点后不支持降级。

### 限额与恢复

所有限额都是 Schemastery 插件配置字段，在插件加载时验证。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | 常规 Harness home | 私有媒体根目录覆盖。 |
| `requestTimeoutMs` | `120000` | 聊天和图片总时限。 |
| `videoTimeoutMs` | `900000` | 视频总时限，包含轮询和下载。 |
| `pollIntervalMs` | `2000` | 成功读取视频状态之间的间隔。 |
| `maxRequestBytes` | `1048576` | 完整留存输入和服务配置的字节限额。 |
| `maxResponseBytes` | `33554432` | 累计 HTTP JSON/SSE 及留存帧限额。 |
| `maxMediaBytes` | `104857600` | 每次请求全部生成媒体及参考图的字节限额。 |
| `maxConcurrent` | `2` | 同时运行数；超额请求失败而不排队。 |
| `maxHistory` | `100` | 留存的已结束请求数；不移除运行中请求。 |

提供方错误使用带稳定 `DIRECT_AI_*` 代码的 `DirectAiError`。错误消息从不包含提供方响应正文、key 或传输诊断。请求和失败的状态读取均不重试。取消会停止本地 HTTP、轮询及下载；已提交的提供方任务可能继续运行并产生费用。重启把未完成记录标为取消，不会重新提交。存储失败会显式拒绝；成功后的历史清理失败保留已保存的完成结果并发出警告。

### 凭据与媒体

`save` 仅在输入中接受 API key。省略时保留已保存 key，空字符串时删除。`catalog` 和 `save` 仅返回 `configured`，不返回 key 或掩码预览。凭据使用 credentials 服务；元数据和请求结果历史使用 `direct_ai` 存储 domain。新 home 没有服务或历史。

生成文件使用 `$DSH_HOME/data/direct-ai/media` 下独占创建的随机名称；操作系统支持时目录权限为 `0700`、文件权限为 `0600`。仅检测为 PNG/JPEG/WebP/GIF 和 MP4/WebM 的字节可内联提供；拒绝 SVG 和 HTML。`GET`/`HEAD /api/direct-ai/media?id=<opaque>` 是经过身份验证、仅限所有者的 Connection 精确路由，支持可选 `download=1`；不接受文件系统路径。帧 URL 相对文档，以兼容代理前缀和 Desktop。留存请求被移除时，其媒体一并删除。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

服务为每个获准操作持有一个取消控制器。卸载时中止并等待 HTTP、轮询、媒体读取及最终历史写入，再关闭 domain。提供方流有显式字节核算及 reader 取消；携带凭据的请求拒绝重定向。实现不调用 Agent registry、Session 生命周期、LLM waterfall 或 Agent 遥测路径。

[类型](src/types.ts) 定义浏览器数据；[验证](src/validation.ts) 接纳配置和 JSON；[协议](src/protocol.ts) 管理外部响应；[存储](src/storage.ts) 声明带版本 domain；[服务](src/index.ts) 管理授权、凭据、留存和私有媒体。[协议测试](tests/protocol.spec.ts) 使用真实 loopback HTTP；[服务测试](tests/service.spec.ts) 通过真实 Loader 组合启动 JSON 存储、credentials 和 Connection。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Credentials](../../credentials/credentials/README.zh.md) — secret 归属及存在状态报告。
- [Storage-domain](../../storage/storage-domain/README.zh.md) — 持久化 schema 验证及关闭顺序。
- [Connection](../../client/connection/README.zh.md) — 经过身份验证的精确 Fetch 路由。
- [架构](../../../docs/architecture.zh.md) — 与 Agent 请求处理分离。
- [Direct AI 子系统](../../../docs/subsystems/direct-ai.zh.md) — 公开请求／结果类型与生成的服务 API。

-----

<a id="model-experience"></a>
## 模型体验

### 直接提供方请求

#### 模型能看到什么

所选聊天模型只收到给定文本 `messages`、所选 `model` 和获准 JSON 参数；不添加 Harness 系统提示、工具、技能、Session 上下文或 Agent 数据。图片和视频生成接收单条用户提示及获准参数。API key 用于 HTTP 身份验证，不属于模型输入。

#### Token 影响

提供方负责分词、生成成本及计费。此服务不添加提示 token，也不采集 Agent token 核算。完整输入和结果历史留在本功能本地，除非所有者显式复制到其他地方。

#### KV Cache 影响

服务不创建或控制提供方缓存。重复的相同聊天前缀可能符合提供方缓存复用条件；模型、消息或参数变化可能阻止复用。每次请求相互独立，不会自动把历史追加到后续请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些约束明确首版支持协议及安全范围。

- 不支持提供方专用扩展、聊天工具、聊天提示附件、仅推理输出、视频参考图片或任意厂商协议。对话只支持一个结果（`n: 1`），多个备选会被拒绝而非合并。
- 媒体传输支持一个字节区间，包括开放结尾和后缀区间；多区间请求返回 HTTP 416。
- 凭据、输入和历史仅限经过身份验证的所有者访问，但不防同一 OS 账号、受信任 Host 插件、备份或已被攻陷的 Host。本地凭据提供方把 key 存在磁盘，受信任进程内代码可调用 `readRecord`。
- 进程丢失可能中断最终输出持久化。派发前输入仍已保存；重启记录中断，不声称远端提供方是否完成或计费。
- 密钥替换使用随服务元数据一同提交的不可变私有引用。保存失败保留此前可调用的配置与密钥；元数据提交失败可能留下不可达的凭据记录。清理失败会记录日志，不会恢复已删除的服务或密钥。
- 提供方进度不保证计费或完成。真实提供方兼容性需由集成应用负责带 key 验证；包测试是无需 key 的 loopback 协议 fixture。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
