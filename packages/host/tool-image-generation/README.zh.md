---
description: "在通用会话中使用已配置的生图服务，执行 owner 回合授权并保留图片结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-generation

[English](README.md) | 中文

## 概述

此插件为普通会话增加生图能力，不把仅生图模型用作聊天路由。设置中可选择已有 Direct AI 生图服务，或使用只写密钥创建服务。作用域工具仅在 owner 驱动的会话回合调用可信提供方，Client 在同一会话展示持久图片附件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

打开**设置 → 模型 → 会话生图**。创建 OpenAI Images 服务，或选择已配密钥的已有生图服务。**保存并用于会话生图**先保存服务，再保存默认引用；第二次写入未确认时，重新加载并选择已保存服务，不要重复创建。**关闭会话生图**清除引用。聊天提供方仍在上方独立配置，其图片输入复选框不启用生图。不会自动迁移已有模型或密钥。

在新会话选择 **Personal chat** 预设，描述希望生成的图片。聊天模型必须支持工具调用。该预设使用通用的完整 persona，抑制运行时及工作区指令，并移除继承的编程工具，保留本地生图工具。原有编程预设仍可选择。生成图片直接展示，并通过常规附件存储在历史重载后保持可用。

aiyoyoo 快捷项填入 `https://www.aiyoyoo.com/v1` 和 `gpt-image-2`。其[公开目录](https://www.aiyoyoo.com/api/v1/llm-pricing/models)在原生和超分生图组列出该模型，[已发布控制台文案](https://www.aiyoyoo.com/assets/index-BdAdvWz0.js)说明独立 `/v1/images/generations` 接口。这不是实时权限检查或成功付费调用验证。密钥的账号分组决定路由，本地标签不会改变它。请配置该密钥获准使用的准确模型。

<a id="understand-the-implementation"></a>
## 理解实现

Host 根服务拥有 volatile `defaultServiceId` 设置引用。只有 Host 标记的 owner 浏览器输入，才能为其确切的活动 Agent 及回合授权生图。外部输入会阻止该回合的后续调用；缺少身份、仅后台输入的回合和被委派 Agent 在提供方派发前失败。执行时检查授权，不只隐藏工具。Direct AI 仍拥有已保存端点、不可变凭据引用、限额、不重试 HTTP 及提供方历史。其可信非 Remote 生图方法仅在完成状态已保存后，返回运行 id 和独立附件引用。

作用域 `./tool` 入口只接受提示词，不接受 URL、凭据、模型覆盖或提供方参数。Session 历史记录工具输入及安全结果；运行 id 关联 Direct AI 历史。两份历史不是同一事务。完成结果无法留存时，提供方可能已经计费，不得自动重试。取消停止本地等待并等自有任务结束，但不能撤销已受理的提供方任务。设置页底部和按工具名索引的图片视图通过已有 slot 注册，图片展示使用共享的授权图库 Factory。

<a id="model-experience"></a>
## 模型体验

### 图片生成

#### 模型看到的内容

[`generate_image` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-image-generation) 向模型请求增加用途说明及一个 `prompt` 参数。个人 persona 增加简短通用指令，不含工作区或编程指导。成功结果包含简短摘要和持久图片引用，不包含 base64 或提供方下载 URL。支持图片的聊天路由可能接收从附件派生的图片输入，明确声明仅文本的路由使用既有文本投影。未知输入能力应准确配置。凭据不会进入工具参数、内容或展示元数据。

#### Token 影响

工具声明、个人 persona、提示词和结果摘要增加模型输入。生图请求增加提供方工作量，可能独立于聊天计费；支持图片的聊天路由收到生成附件时，也可能产生图片输入费用。

#### KV 缓存影响

预设和配置不变时，工具声明与个人 persona 保持稳定。新提示词和保留的图片结果扩展会话历史；提供方侧缓存复用取决于所选聊天路由，插件不保证或控制缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持同步 OpenAI Images 生成。图片编辑、参考图生图、Gemini 图片输出及提供方专用异步任务需要独立适配。不支持工具调用的聊天模型无法自动发起生图。
- 此插件不保证上游模型权限、画质、价格或取消计费。附件保留遵循其存储提供方，与 Direct AI 历史清理独立，应将附件与 Session 一起备份。配置仅限 owner，不向共享查看者授予使用 owner 生图密钥的权限。

<a id="dev-note"></a>
### 开发备注

无。
