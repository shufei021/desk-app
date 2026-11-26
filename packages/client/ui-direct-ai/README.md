---
description: "Direct chat, image and video requests from a personal API service page without an Agent or workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-direct-ai

English | [中文](README.zh.md)

## Summary

Use your own API services for chat, images, and video without opening a workspace or activating an Agent. Only configured capabilities appear in the page. Provider keys are write-only and remain in Host credential storage. The existing Agent conversation remains available separately. This first version supports the OpenAI-compatible protocols described by the [Host provider](../../host/direct-ai/README.md), not arbitrary image or video APIs. The dedicated image workspace moved to [ui-image-studio](../ui-image-studio/README.md); this page still submits image and video requests from its own composer.

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

Open **Direct AI** in the sidebar and select **Add service**. Choose chat, images, or video, and enter its name, base URL, model ID, and API key. The protocol choice is explicit: a key does not disclose its capabilities. Configure several services to use the same key for several capabilities. Saved keys never populate the editor; an empty key while editing preserves its existing value.

The **CrazyToken / aiyoyoo** shortcut fills the chat base URL `https://www.aiyoyoo.com/v1`. **Public model directory** anonymously reads the provider's public groups and models; **Fetch key models** reads the standard `/models` list with an explicit draft key or an unchanged saved service URL. Changing a saved URL requires entering a new key before discovery or saving. Search and platform/group menus filter returned identifiers; selecting a model fills its ID and local annotations without changing capability, account group, or billing route. Saved services have the same search and annotation filters. Public listings do not establish key entitlement or image/video compatibility, and no price estimate is shown.

Choose a configured service, enter your input, and send it once. Chat preserves the conversation on this page; its optional system prompt is sent only when you supply it. Images and video submit one generation prompt. Extra JSON parameters are explicit provider arguments, not a way to replace the model, input, or tools. **New chat** clears page context without deleting durable request history. **Back to Agent** returns to the existing workspace conversation.

The page retains partial output after failure. Requests do not automatically retry or reconnect because that can duplicate charges. **Stop local request** cancels local HTTP and polling; it cannot guarantee cancellation of an accepted provider job. Request history shows retained Host input and output and can display a record after its service was removed. Readback is required when a configuration write was not confirmed.

The Web composition mounts this browser plugin beside its Host provider. Its `openOnStart` configuration defaults to `true`; set it to `false` in the `ui-direct-ai` profile row to preserve the initial Agent page. This affects initial navigation only and does not remove the sidebar entry. Owner authentication is still required. Provider configuration is independent of **Settings → Models**, which configures the Agent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client contributes one root-scoped main page and one sidebar entry through Slots. Its own browser controller instance comes from the shared `@deepseek-ai/dsh-client-direct-ai-client` package and consumes the generated `directAi` namespace mounted by API Remotes. It keeps the last authoritative catalog and history on query failure and owns one cancellable, non-reconnecting request. Locale dictionaries own UI copy; no credential is stored in page preferences. Disposing the plugin joins its active request before withdrawing presentation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Direct provider](../../host/direct-ai/README.md) — supported protocols, security, storage, and limits.
- [Image workspace](../ui-image-studio/README.md) — the dedicated image panel, presets, masks, assets, and variants.
- [Shared direct controller](../direct-ai-client/README.md) — the controller this page mounts.
- [Slots](../../../docs/subsystems/slots.md) — page composition and lifecycle.
- [API Remotes](../../api/remotes/README.md) — generated service selection.

-----

<a id="model-experience"></a>
## Model Experience

### Explicit direct request

#### What the model sees

The page contributes no Agent tools, persona, workspace instructions, skills, or automatic system prompt. The selected direct service receives the user's explicit request through the Host provider and uses independent request history rather than Agent Session logs.

#### Token effect

Only explicitly supplied `messages`, optional `system` text, provider parameters, and the fixed template of a selected image preset contribute to the model request. The page adds no instruction you did not choose; the provider determines usage and charges.

#### KV Cache effect

Only user-supplied chat history, optional system text, and provider parameters affect the direct request prefix. Switching services or starting a new chat clears the page's context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This version accepts text and reference-image input only; uploaded video inputs and audio generation require separate adapters.
- Capability configuration is a declaration, not a connectivity or entitlement test. An invalid key can still be saved; a provider rejection is shown on submission.
- Page drafts and multi-turn selection are browser-memory state. The retained Host request history survives a reload, but active streams do not reconnect or resubmit.
- Opening history restores the explicit system prompt and per-request parameters. Service defaults still come from the current configuration; inspect them before extending an older conversation.
- English is the fallback for UI locales without a dedicated dictionary.

<a id="dev-note"></a>
### Dev Note

None.
