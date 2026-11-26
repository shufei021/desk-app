---
description: "磁盘上每个工作区各自的图片资产目录：基于工作区注册表的 workspaceAssets Remote 命名空间，以及返回已存图片的经过身份验证的字节路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-assets

[English](README.md) | 中文

## 概述

把每个工作区的图片库放在该工作区自己的目录里，而不是浏览器存储中。Host 在 Workspace 注册表和 Connection 旁挂载此包。浏览器通过 `workspaceAssets` Remote 命名空间读取已注册工作区、列出已存图片、保存上传字节并删除文件，并通过经过身份验证的 `GET /api/workspace-assets/file` 路由显示已存图片。已存图片是 `<workspace>/资产库/<category>/<title>.png` 下的普通 PNG、JPEG 和 WebP 文件，因此图片库在浏览器存储被清空后仍然存在，随目录一起迁移，并可在文件管理器中直接查看。

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

在 Workspace 注册表和 Connection 旁挂载此服务；浏览器消费者调用生成的 `workspaceAssets` Remote 命名空间，并直接加载返回的 URL。

### 目录布局

每张已存图片都是工作区目录下的一个文件：`<workspace.path>/<folderName>/<分类目录>/<标题>.<扩展名>`。三个分类目录是固定产品词汇：`character` 为 `角色`，`scene` 为 `场景`，`prop` 为 `道具`。文件名即标题，并经过清洗：去掉路径分隔符（`/` 和 `\`）、控制字符、Windows 保留标点 `:*?"<>|`，以及首尾的点和空格；什么都不剩的标题回退为 `asset`。扩展名由声明的媒体类型决定：`image/png` 写入 `.png`，`image/jpeg` 写入 `.jpg`，`image/webp` 写入 `.webp`。已被占用的名称依次追加 `-2`、`-3`，最多尝试二十次。

不写索引文件；目录列表就是图片库，因此在 GUI 之外新增、重命名或删除的文件会在下次调用时出现，无需迁移。`list` 只返回带受支持扩展名的常规文件，跳过子目录和符号链接，并把缺失的目录当作空图片库而不创建它。图片库自己永远不会写出的文件名，例如隐藏的 `.name.png`，不会被列出。

### Remote 操作

| 方法 | 返回 | 含义 |
|---|---|---|
| `workspaces()` | `{ id, title, path }[]` | 已注册工作区，按注册表顺序。 |
| `list(workspaceId)` | `WorkspaceAsset[]` | 已存图片，先按分类顺序 `character`、`scene`、`prop`，再按文件名称顺序。 |
| `save(input)` | `WorkspaceAsset` | 保存 `data`，必须是规范 base64 且不带 `data:` 前缀；`mime` 为 `image/png`、`image/jpeg` 或 `image/webp`。 |
| `removeAsset(workspaceId, category, name)` | `boolean` | 删除 `name`，即含扩展名的已存文件名；没有常规文件持有该名称时返回 `false`。线上方法不能命名为 `remove`，已挂载的客户端命名空间把该名称用于自身的挂载记录。 |

`WorkspaceAsset` 包含 `name`、`title`（不含扩展名的文件名）、`category`、`bytes`、以毫秒计的 `modifiedAt`，以及 `url`：相对文档的 `api/workspace-assets/file?id=<name>&workspace=<id>&category=<category>`，因此代理前缀和 Desktop 分发都能继续工作。

### 字节路由

`GET` 与 `HEAD /api/workspace-assets/file` 组成一条 Connection 精确路由，只有经过身份验证的所有者 Peer 能到达。命中时返回图片字节、按扩展名确定的 `content-type`、`cache-control: private, no-store`、`x-content-type-options: nosniff` 和 `content-disposition: inline`。未知工作区、未知分类、图片库不会写出的名称、非常规文件、符号链接，以及超过 `maxAssetBytes` 的文件一律返回不带路径也不带原因的 `404`，因此该路由从不泄漏工作区结构。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `folderName` | `资产库` | 图片库在每个工作区内拥有的目录名；必须是单个路径段。 |
| `maxAssetBytes` | `8388608` | 接受并可返回的最大图片字节数。 |

### 失败

失败是带稳定代码的 `WorkspaceAssetError`，其消息从不包含工作区路径或文件名。`WORKSPACE_ASSET_INVALID_INPUT` 覆盖非法分类、媒体类型、base64 载荷、文件名或目录名；`WORKSPACE_ASSET_TOO_LARGE` 覆盖超过 `maxAssetBytes` 的载荷；`WORKSPACE_ASSET_NOT_FOUND` 覆盖未知工作区；`WORKSPACE_ASSET_STORAGE_FAILED` 覆盖不可读的目录、二十次尝试后仍被占用的名称，以及失败的写入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

每个路径都由 `join(workspace.path, folderName, 分类目录, name)` 构造、解析，并且只有仍位于解析后的工作区目录之下才被接受。写入使用 `open(..., 'wx', 0o600)`，因此已存在的文件（包括符号链接）既不会被跟随也不会被替换；分类目录按需以 `0o700` 创建，并重新确认是真实目录。读取先调用 `lstat`，要求是配置限额内的常规文件且不是符号链接；缺失、被链接或不是目录的资产目录按空列表处理。

[类型](src/types.ts) 定义载荷；[命名与包含规则](src/library.ts) 负责文件名、媒体类型和目录规则；[服务](src/index.ts) 负责 Remote 命名空间和字节路由；[配置](src/config.ts) 声明两个部署字段。[服务测试](tests/service.spec.ts) 在临时工作区目录和注册表座位之上组合真实 Connection 插件，覆盖字节路由、各类拒绝及卸载。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Workspace](../../workspace/workspace/README.zh.md) — 这些目录所依附的记录注册表。
- [Connection](../../client/connection/README.zh.md) — 经过身份验证的精确 Fetch 路由。
- [Directory picker](../../host/directory-picker/README.zh.md) — 另一个提供工作区目录界面的 GUI Host 能力。

-----

<a id="model-experience"></a>
## 模型体验

### 工作区资产库

#### 模型能看到什么

无。`workspaceAssets` 命名空间只把图片保存、列出和删除为工作区目录下的文件；本包不注册工具、提示段落、系统提示文本或 Session 事件，因此任何资产名称、字节或路径都不会进入模型请求。

#### Token 影响

无。图片库不发起模型请求，也不增加输入 token；已存图片只有在用户自己的提示激活了某个独立消费者时才到达模型。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **每个分类只有一个平铺目录。** 分类是固定产品词汇，文件不能在其下再分组，拥有数千张图片的工作区每次调用都会全部列出。
- **没有索引、元数据或历史。** 目录是唯一状态：标题来自文件名，删除会直接丢弃文件，没有回收站、撤销或引用检查。
- **仅支持图片。** 只存储并提供 PNG、JPEG 和 WebP；其他格式和任何非图片资产会被拒绝而不是转换。
- **文件系统权限尽力而为。** `0o700` 与 `0o600` 仅在操作系统支持时生效；图片库从不加密字节，也无法阻挡同一操作系统账号访问工作区目录。
- **并发保存按名称竞争。** 同一标题的两次并发保存通过独占创建解决，因此其中一个得到 `-2`；尝试二十次仍失败的保存会报错而不是排队等待。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
