---
description: "直接交互页面与图像工作区共用的浏览器控制器和主面板 face。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-direct-ai-client

[English](README.md) | 中文

## 概述

围绕生成的 `directAi` Remote 提供一个浏览器控制器：目录与请求历史、同一时间一个可取消且不重连的请求、临时模型目录，以及提示词助手与变体流。直接交互页面（`@deepseek-ai/dsh-client-ui-direct-ai`）与图像工作区（`@deepseek-ai/dsh-client-ui-image-studio`）各自创建自己的 `DirectController` 实例，并通过 `pageFace` 获得相同的 `DirectPageInjected` face，因此两个插件都不在运行时导入对方。本包还拥有结果卡片显示的留存请求参数事实。它是 Web shell 静态播种的平台模块，不是 Loader 插件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

需要访问已配置直接提供方的 UI 插件导入 `DirectController`，并用 `pageFace(controller, backToAgent, select)` 构建主面板的注入 face。在 `ctx.remoteAccess.whenAccess('directAi/catalog', …)` 内创建控制器，并随插件 fiber 一起释放。当选择还需要写入浏览器本地状态时传入 `select` 处理器，图像工作区就是用它记住上次选择的服务。控制器在读取失败时保留已缓存数据，绝不自动重试请求，并且同一时间只持有一个流。

本包不是插件：不导出 `apply`、`inject` 或 `Config`。它通过 `staticLinked` 构建加入 `PLATFORM_MODULES`，由 Web shell 为每个动态 bundle 播种该模块身份。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`DirectController` 把生成的 Remote 调用封装在 snapshot store 中，渲染方通过标准 host observable source 读取 `catalog`、`interaction`、`history` 与 `directory`。请求流只结算一次并写入 interaction store，释放时会等待活动请求结束。`pageFace` 把这些 source 与控制器的动作映射为 `DirectPageInjected` 类型，自身不保存状态。`imageParamFacts` 解析留存请求中明确的 `size`、`quality` 与 `n` 字段用于展示，不信任它们的 JSON 类型。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [直接交互页面](../ui-direct-ai/README.zh.md) — 对话、生图与视频服务的配置与请求。
- [图像工作区](../ui-image-studio/README.zh.md) — 图像面板、预设、蒙版、资产库与变体。
- [直接提供方](../../host/direct-ai/README.zh.md) — 支持的协议、安全、存储与限制。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package only prepares browser-side request state that its consuming pages submit.（本包只准备浏览器请求状态，由使用它的页面提交。）

#### KV Cache 影响

无；控制器既不组装也不发送模型请求，请求前缀由各页面拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 控制器每个实例只跟踪一个进行中的请求，因此需要并发的页面在同一实例上组合多个流，而不是创建第二个实例。
- face 只暴露两个页面都使用的动作；页面专属需求留在该页面自己的注入隔间里。

<a id="dev-note"></a>
### 开发备注

无。
