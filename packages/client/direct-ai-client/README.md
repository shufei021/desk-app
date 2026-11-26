---
description: "Shared browser controller and main-panel face for the Direct AI page and the image workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-direct-ai-client

English | [中文](README.zh.md)

## Summary

One browser controller over the generated `directAi` Remote: the catalog and request history, one cancellable non-reconnecting request at a time, the transient model directory, and the prompt-assistant and variant streams. The Direct AI page (`@deepseek-ai/dsh-client-ui-direct-ai`) and the image workspace (`@deepseek-ai/dsh-client-ui-image-studio`) each mount their own `DirectController` instance and receive the same `DirectPageInjected` face from `pageFace`, so neither plugin runtime-imports the other. This package also owns the retained-request parameter facts the result card displays. It is a static platform module seeded by the Web shell, not a Loader plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

A UI plugin that talks to a configured direct provider imports `DirectController` and builds its main-panel inject face with `pageFace(controller, backToAgent, select)`. Create the controller inside `ctx.remoteAccess.whenAccess('directAi/catalog', …)` and dispose it with the plugin fiber. Pass a `select` handler when selection must also persist browser-local state, as the image workspace does for its remembered service. The controller caches retained data on read failure, never retries a request automatically, and owns one stream at a time.

The package is not a plugin: it exports no `apply`, `inject`, or `Config`. Add it to `PLATFORM_MODULES` only through its `staticLinked` build; the Web shell seeds that module identity for every dynamic bundle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`DirectController` wraps the generated Remote calls in snapshot stores, so a renderer reads `catalog`, `interaction`, `history`, and `directory` through the standard host-observable source. Request streams settle into the interaction store once, and disposal joins the active request. `pageFace` maps those sources and the controller's actions to the `DirectPageInjected` type without holding state of its own. `imageParamFacts` parses the explicit `size`, `quality`, and `n` fields of a retained request for display; it never trusts their JSON types.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Direct AI page](../ui-direct-ai/README.md) — chat, image, and video service configuration and requests.
- [Image workspace](../ui-image-studio/README.md) — the image panel, presets, masks, assets, and variants.
- [Direct provider](../../host/direct-ai/README.md) — supported protocols, security, storage, and limits.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package only prepares browser-side request state that its consuming pages submit.

#### KV Cache effect

None; the controller neither assembles nor sends model requests, and each consuming page owns its provider prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The controller tracks one in-flight request per instance, so a page that needs concurrent streams composes them over the same instance rather than creating a second one.
- The face exposes only the actions both pages use; a page-specific need stays in that page's own inject compartment.

<a id="dev-note"></a>
### Dev Note

None.
