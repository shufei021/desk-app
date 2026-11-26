---
description: "在不使用 Agent 或工作区的个人 API 服务页面中，直接进行对话、生图与视频请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-direct-ai

[English](README.md) | 中文

## 概述

使用你自己的 API 服务进行对话、生图和视频生成，无需打开工作区或激活 Agent。页面只显示已配置的能力。提供商密钥只写入 Host 凭据存储。原有 Agent 对话仍可单独使用。此版本支持 [Host 提供方](../../host/direct-ai/README.zh.md)说明的 OpenAI 兼容协议，不支持任意厂商的图片或视频接口。独立的图像工作区已迁到 [ui-image-studio](../ui-image-studio/README.zh.md)；本页仍从自己的输入框提交生图与视频请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在侧栏打开**直接交互**并选择**添加服务**。选择对话、生图或视频，输入名称、基础地址、模型 ID 和 API 密钥。协议由你明确选择，密钥本身不表明它支持哪些能力。同一个密钥可以配置为多个服务以使用不同能力。已保存的密钥不会回填编辑框；编辑时密钥留空会保留原值。

**CrazyToken / aiyoyoo** 快捷选项填入对话基础地址 `https://www.aiyoyoo.com/v1`。**公开模型目录**匿名读取服务商公开分组和模型；**获取此密钥模型**使用明确的草稿密钥，或地址未变的已保存服务读取标准 `/models` 列表。修改已保存地址后，必须填写新密钥才可获取目录或保存。搜索及平台、分组菜单筛选返回的标识；选择模型填入 ID 和本地注释，不改变能力、账号分组或计费路由。已保存服务也支持相同的搜索和标签筛选。公开目录不证明密钥权限或生图视频兼容性，不展示价格估算。

选择已配置的服务，输入内容并发送一次。对话会保留此页面上的上下文，仅在你明确填写时发送可选系统提示词。生图与视频每次提交一条生成提示词。额外 JSON 参数是明确的提供商参数，不能替换模型、输入或工具。**新对话**清除页面上下文，不删除持久请求历史。**返回 Agent**打开原有工作区对话。

请求失败后页面保留部分输出。请求不会自动重试或重连，以免重复计费。**停止本地请求**取消本地 HTTP 和轮询，不能保证取消服务商已受理的任务。请求历史展示 Host 保留的输入和输出，原服务已删除的记录仍可查看。配置写入未确认时，应先重新读取核对。

Web 组合将本浏览器插件与 Host 提供方一起挂载。`openOnStart` 配置默认为 `true`；在 `ui-direct-ai` profile 行中设置为 `false` 可保留初始 Agent 页面。这只影响初始导航，不移除侧栏入口。仍然要求 owner 身份认证。此处提供商配置独立于用于配置 Agent 的**设置 → 模型**。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Client 通过 Slots 提供一个 root 作用域主页面和一个侧栏入口。自己的浏览器控制器实例来自共享的 `@deepseek-ai/dsh-client-direct-ai-client` 包，并消费 API Remotes 挂载的生成 `directAi` namespace。查询失败时保留最后一次权威目录和历史，并持有一个可取消、不重连的请求。UI 文案由语言字典拥有，页面偏好不存储任何凭据。插件释放时等待活动请求结束，再撤回界面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [直接提供方](../../host/direct-ai/README.zh.md) — 支持的协议、安全、存储与限制。
- [图像工作区](../ui-image-studio/README.zh.md) — 独立的图像面板、预设、蒙版、资产库与变体。
- [共享直接控制器](../direct-ai-client/README.zh.md) — 本页挂载的控制器。
- [Slots](../../../docs/subsystems/slots.zh.md) — 页面组合与生命周期。
- [API Remotes](../../api/remotes/README.zh.md) — 生成服务的选择。

-----

<a id="model-experience"></a>
## 模型体验

### 明确的直接请求

#### 模型看到的内容

页面不提供 Agent 工具、角色、工作区指令、技能或自动系统提示词。所选直接服务通过 Host 提供方接收用户明确输入的请求，并使用独立请求历史而非 Agent Session 日志。

#### Token 影响

只有明确填写的 `messages`、可选 `system` 文字、提供商参数，以及所选图像预设的固定模板进入模型请求。页面不添加你未选择的指令，使用量和费用由提供商决定。

#### KV Cache 影响

只有用户提供的对话历史、可选系统文字和提供商参数影响直接请求的前缀。切换服务或开始新对话会清空页面上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 此版本只接受文本和参考图输入；上传视频输入和音频生成需要单独适配器。
- 能力配置是声明，不是连接或权限测试。无效密钥也可能保存，请求时会显示服务商拒绝。
- 页面草稿和多轮选择保存在浏览器内存。Host 保留的请求历史跨刷新存在，但活动流不会重连或重新提交。
- 打开历史会恢复明确的系统提示词与逐请求参数。服务默认值仍取自当前配置，继续旧对话前应检查这些值。
- 没有独立字典的 UI 语言回退到英文。

<a id="dev-note"></a>
### 开发备注

无。
