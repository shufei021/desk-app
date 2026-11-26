---
kind: upgrade-guide
description: "个人 Web 构建的新会话默认使用 Personal chat 和独立生图配置，并禁用官方模型凭据自动引导。"
---

# 个人会话与生图服务

[English](guide.md) | 中文

## 变更

个人 Web 构建打开会话而非直接交互，新 Session 默认使用不含编程或工作区指令的 **Personal chat**。已有 Session 保留其预设与聊天模型选择。**设置 → 模型**中的仅生图模型不是生图服务，独立的**会话生图**分区选择聊天工具使用的已保存生图服务。直接交互仍是可选独立页面。官方模型凭据自动引导已禁用。

直接交互存储写入版本 2，接受缺少展示注释的版本 1 服务记录；打开旧记录不会重写它们，编辑后不支持降级。直接交互与 Session 图片结果使用独立存储引用，不会在配置域之间自动迁移密钥或模型。

## 迁移

1. 升级前备份 Harness home 和附件存储。保留已有个人 Desktop home，不要将其替换为官方应用目录。
2. 打开**设置 → 模型 → 会话生图**，使用独立地址、模型 ID 和密钥创建 OpenAI Images 服务，或选择已有生图服务。服务保存成功但默认选择未确认时，重新加载并选择它，不要重复创建。
3. 使用支持工具调用的聊天模型，在新会话选择 **Personal chat**。请求生成图片，确认结果出现在同一会话中。配置已保存不代表上游权限有效；请用一个小型明确请求确认，并核对服务商费用。
4. 已有 Session 保留记录的预设。请明确切换，或创建新 Session；编程任务仍可选择 `standard` 等编程预设。已保存的 `agent-preset-registry.selectedDefault` 优先于新默认值，直至在设置中修改。
5. 若需启动时打开直接交互，在 `ui-direct-ai` profile 行设置 `openOnStart: true`。若需恢复官方 Agent 凭据引导，在 `ui-settings-models` 设置 `credentialOnboarding: true`。patch 替换整行配置，需保留使用中的其他字段。
