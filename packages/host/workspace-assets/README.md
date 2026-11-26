---
description: "Per-workspace image asset folders on disk: the workspaceAssets Remote namespace over the Workspace registry, plus the authenticated byte route that returns a stored image."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-assets

English | [中文](README.zh.md)

## Summary

Keep each workspace's image library inside that workspace's own directory instead of browser storage. A Host mounts this package beside the Workspace registry and Connection. The browser reads the registered workspaces, lists stored images, saves uploaded bytes, and removes files through the `workspaceAssets` Remote namespace, and shows a stored image through the authenticated `GET /api/workspace-assets/file` route. Stored images are plain PNG, JPEG, and WebP files below `<workspace>/资产库/<category>/<title>.png`, so the library survives a browser storage reset, travels with the directory, and stays inspectable in a file manager.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this service beside the Workspace registry and Connection; the browser consumer calls the generated `workspaceAssets` Remote namespace and loads returned URLs directly.

### Folder layout

Every stored image is one file below the workspace directory: `<workspace.path>/<folderName>/<category directory>/<title>.<extension>`. The three category directories are fixed product vocabulary: `character` is `角色`, `scene` is `场景`, and `prop` is `道具`. The file name is the title, sanitized: path separators (`/` and `\`), control characters, the Windows-reserved punctuation `:*?"<>|`, and leading or trailing dots and spaces are removed, and a title that keeps nothing becomes `asset`. The extension follows the declared media type: `image/png` writes `.png`, `image/jpeg` writes `.jpg`, and `image/webp` writes `.webp`. A name that is already taken gains `-2`, `-3`, and so on, for at most twenty attempts.

No index file is written; the directory listing is the library, so files added, renamed, or deleted outside the GUI appear on the next call with no migration. `list` reports only regular files with a served extension, skips subdirectories and symbolic links, and treats a missing folder as an empty library without creating it. Files whose names the library would never write, such as a hidden `.name.png`, are not listed.

### Remote operations

| Method | Returns | Meaning |
|---|---|---|
| `workspaces()` | `{ id, title, path }[]` | Registered workspaces, in registry order. |
| `list(workspaceId)` | `WorkspaceAsset[]` | Stored images in category order `character`, `scene`, `prop`, then file name order. |
| `save(input)` | `WorkspaceAsset` | Stores `data` as canonical base64 without a `data:` prefix, with `mime` `image/png`, `image/jpeg`, or `image/webp`. |
| `removeAsset(workspaceId, category, name)` | `boolean` | Deletes `name`, the stored file name including its extension; `false` when no regular file holds it. The wire method cannot be named `remove`, which a mounted client namespace reserves for its own bookkeeping. |

`WorkspaceAsset` carries `name`, `title` (the name without its extension), `category`, `bytes`, `modifiedAt` in epoch milliseconds, and `url`: the document-relative `api/workspace-assets/file?id=<name>&workspace=<id>&category=<category>`, so a proxy prefix and Desktop delivery keep working.

### The byte route

`GET` and `HEAD /api/workspace-assets/file` form an exact Connection route, so only an authenticated owner Peer reaches it. A stored image is answered with its bytes, `content-type` by extension, `cache-control: private, no-store`, `x-content-type-options: nosniff`, and `content-disposition: inline`. An unknown workspace, an unknown category, a name the library would not write, a non-regular file, a symbolic link, and a file above `maxAssetBytes` all answer `404` with no path and no reason, so the route never discloses the workspace layout.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `folderName` | `资产库` | Directory name the library owns inside each workspace; it must be one path segment. |
| `maxAssetBytes` | `8388608` | Largest accepted and served image, in bytes. |

### Failures

Failures are typed `WorkspaceAssetError` values with stable codes, and their messages never contain a workspace path or a file name. `WORKSPACE_ASSET_INVALID_INPUT` covers a bad category, media type, base64 payload, file name, or folder name; `WORKSPACE_ASSET_TOO_LARGE` a payload above `maxAssetBytes`; `WORKSPACE_ASSET_NOT_FOUND` an unknown workspace; and `WORKSPACE_ASSET_STORAGE_FAILED` an unreadable folder, a name still taken after twenty attempts, or a failed write.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every path is built from `join(workspace.path, folderName, categoryDirectory, name)`, resolved, and refused unless it stays below the resolved workspace directory. A write uses `open(..., 'wx', 0o600)`, so an existing file, including a symbolic link, is neither followed nor replaced; the category folder is created on demand with mode `0o700` and re-checked as a real directory. A read calls `lstat` and requires a regular, non-symbolic-link file within the configured size limit, and an asset folder that is missing, linked, or not a directory lists as empty.

[Types](src/types.ts) define the payloads; [naming and containment](src/library.ts) own the file-name, media-type, and directory rules; [the service](src/index.ts) owns the Remote namespace and the byte route; [configuration](src/config.ts) declares the two deployment fields. [Service tests](tests/service.spec.ts) compose the real Connection plugin over temporary workspace directories and a registry seat, and cover the byte route, the rejections, and teardown.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace](../../workspace/workspace/README.md) — the registry whose records these folders hang from.
- [Connection](../../client/connection/README.md) — authenticated exact Fetch routes.
- [Directory picker](../../host/directory-picker/README.md) — the other GUI-host capability with a workspace-directory surface.

-----

<a id="model-experience"></a>
## Model Experience

### Workspace asset library

#### What the model sees

None. The `workspaceAssets` namespace stores, lists, and removes images only as files below a workspace directory; the package registers no tool, prompt section, system-prompt text, or Session event, so no asset name, byte, or path enters a model request.

#### Token effect

None. The library issues no model request and adds no input tokens; a stored image reaches a model only through a separate consumer that the user's own prompt activates.

#### KV Cache effect

None; this package never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One flat folder per category.** The categories are fixed product vocabulary, files cannot be grouped below them, and a workspace with thousands of images lists them all on every call.
- **No index, metadata, or history.** The directory is the only state: titles come from file names, and a removal discards the file with no trash, undo, or reference check.
- **Images only.** PNG, JPEG, and WebP are stored and served; any other format and any non-image asset is refused rather than converted.
- **Filesystem permissions are best effort.** Modes `0o700` and `0o600` apply where the operating system honours them; the library never encrypts bytes and cannot protect a workspace directory from the same operating-system account.
- **Concurrent saves race on names.** Two concurrent saves of one title resolve through exclusive create, so one receives `-2`; a save that exhausts twenty attempts fails instead of waiting.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
