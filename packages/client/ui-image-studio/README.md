---
description: "Image generation workspace over configured image services, with parameters, presets, masks, grid splitting, an asset library, style variants, and a prompt assistant."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-image-studio

English | [中文](README.zh.md)

## Summary

Generate images with the image services you configured in **Settings → Models → Conversation images**, without a chat model, tool call, or Agent turn. The workspace lists recent generations, reopens retained results, downloads images, and keeps its own parameter selection, presets, reference images, masks, asset library, style variants, and prompt assistant. It shares the Direct AI Remote and request history with the [Direct AI page](../ui-direct-ai/README.md) but is an independent browser plugin: the image panel, its sidebar entry, and the conversation mode bar come from this package alone. Provider keys stay write-only in Host credential storage.

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

Open **Image generation** in the sidebar. The page lists only configured services whose capability is image, and each submission calls the image endpoint directly, so the chat model need not support tool calls. The workspace lists recent generations, reopens retained results, and downloads images. Each result card shows the prompt that produced it beside the image, with the service, model, time, reference count, and preset, and offers copying and reusing that prompt; the Host retains the prompt with the run, so it survives a reload while preset template text stays out of it. Recent generations are titled with the prompt's first line. Generated results can be split along their white grid lines into downloadable panels. One request can carry up to 8 reference images, which are stored as attachments and sent as reference-image editing. The **Workspace** switch above the conversation composer moves between chat and image generation without changing existing session history. With no image service, add one and save its key under **Settings → Models → Conversation images** first.

The image composer is a description box above one tool row. On the left, **+** adds up to eight reference images (their thumbnails stay above the description, and an applied mask is marked on its thumbnail), followed by the **Generation mode** menu, the **Asset library**, the **Prompt assistant**, **Parameters**, and **Style variants**; on the right sit the character counter (`n/4000`), the service menu, and the send or stop control. The send control becomes **Stop local request** while a run is in flight.

The **Generation mode** menu switches between free-form generation and two fixed templates: **Character turnaround** renders a studio portrait beside an orthographic front, side, and back view, and **Scene multi-view** renders a 2×2 grid of distinct camera angles. Both templates need exactly one reference image and append their fixed instruction after your description, so the description may be left empty; the composer still shows only your text. Switching modes preserves the description and the references. Preset templates are model prompts, not localized UI copy.

**Parameters** sets the aspect ratio (ten fixed ratios or **Source image**, which follows the first reference image), the resolution (1K/2K/3K/4K long edge), the quality (low, medium, high), the number of images (1–4), and the exact width and height. Sizes converge in place instead of failing at submission: both edges are multiples of 16, the area stays within 8,294,400 pixels, and the longer edge is at most three times the shorter one; the ratio lock derives the other edge while you type. The chosen size, quality, and count are submitted as explicit `size`, `quality`, and `n` parameters, this browser remembers the selection, and the result card shows all three. A composer that never opened the dialog sends no parameters and leaves them to the provider.

The **Prompt assistant** button sits between the asset library and **Parameters**. It streams an expansion from a configured chat service into an inline panel above the tool row; the fixed instruction asks for one Chinese text-to-image prompt covering subject, composition, light, material, style, and quality, within 600 characters. **Expand** sends the current description, **Stop expanding** ends local waiting, **Use this prompt** writes the answer into the description without submitting or changing parameters, and **Regenerate** asks again with the same description. This browser remembers the chosen chat service. Without a configured chat service the button is disabled and points at the setup hint. Each expansion is an ordinary chat request retained in Direct AI request history; it never starts an image generation.

**Style variants** runs the same description through several visual styles and shows the results side by side. Choose a batch size of 2, 3, or 4 and check the styles to include — photorealistic, cinematic, illustration, 3D render, or watercolor — then **Start batch**. The checked styles run one after another, never concurrently, so a provider's concurrency limit and the spend stay predictable; the panel shows the current column, keeps every column that settled, and a failed style shows its provider code while the remaining styles continue. **Stop batch** aborts the running stream and every later style, keeping the columns already finished. Each column offers **Open or download** and **Use this one**, which writes the description plus that style's suffix into the description box and closes the panel without submitting. Every column carries the composer's current parameters, and its retained history entry shows the styled prompt that produced it. The style suffixes are model prompts, not localized UI copy.

While the description implies a selection different from the current parameters, a suggestion bar above the tool row shows the ratio, resolution, quality, count, and its reason. The selected generation preset decides first, then composition words (vertical, portrait, landscape, panoramic, square), quality words (4K, print, or high detail versus sketch, quick, or thumbnail), and quantity words (several options or a comparison set); attached reference images cap a 4K target at 2K because their long edge is usually no larger. **Apply** stores the suggestion as the composer parameters and remembers them, while **Ignore** hides it until the description changes. Neither action submits a request, and a suggestion that already matches the current parameters is not shown.

With exactly one reference image attached and **Mask editing** chosen in the generation-mode menu, **Edit mask** opens a brush over that image; erased areas become transparent, and the PNG mask is saved as an attachment submitted with the request so the provider edits only those areas.

The **Asset library** keeps reference images in the asset folders of a registered workspace. The panel lists the registered workspaces and reopens the one you chose last in this browser, otherwise the first. Each image is stored below `资产库/角色`, `资产库/场景`, or `资产库/道具` in that workspace; the file name is the title, and a repeated title gains a sequence number. Use a stored asset as a reference image: the Client fetches it from the Host, converts it back into a file, and uploads it through the same path as a manually chosen file, so the eight-reference limit applies. Every asset shows its category and modification time, and deleting one takes a second confirming click. The files stay on the workspace disk, so they open in your file manager, survive a browser data reset, and each workspace keeps its own library.

The Web composition mounts this browser plugin beside the Direct AI Host provider and the Direct AI page. It registers the image panel, the sidebar entry, and the conversation input mode bar; the Direct AI page registers its own panel and service editor. Owner authentication is still required, and provider configuration remains independent of **Settings → Models**, which configures the Agent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This plugin contributes one root-scoped main panel, one sidebar entry, and one `conversation.input.dock` mode bar through Slots. It mounts its own `DirectController` instance from the shared `@deepseek-ai/dsh-client-direct-ai-client` package over the generated `directAi` namespace mounted by API Remotes, so the image workspace and the Direct AI page never share runtime request state. The asset panel reads the `workspaceAssets` namespace and shows stored images through the authenticated Host byte route. Locale dictionaries own UI copy in the `imageStudio` namespace; no credential is stored in page preferences. Disposing the plugin joins its active request before withdrawing presentation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Direct provider](../../host/direct-ai/README.md) — supported protocols, security, storage, and limits.
- [Direct AI page](../ui-direct-ai/README.md) — chat, image, and video service configuration and requests.
- [Shared direct controller](../direct-ai-client/README.md) — the controller both pages mount.
- [Slots](../../../docs/subsystems/slots.md) — page composition and lifecycle.
- [API Remotes](../../api/remotes/README.md) — generated service selection.

-----

<a id="model-experience"></a>
## Model Experience

### Direct image request

#### What the model sees

The image workspace contributes no Agent tools, persona, workspace instructions, skills, or automatic system prompt. The selected image service receives the user's description, reference images, mask, and explicit parameters through the Host provider; the prompt assistant's fixed instruction reaches only the chat service the user chose.

#### Token effect

Only the description, the selected preset template or variant suffix, the fixed assistant instruction, and the explicit `size`, `quality`, and `n` parameters contribute to the provider request. The workspace adds no instruction you did not choose; the provider determines usage and charges.

#### KV Cache effect

Only user-supplied prompts, preset templates, and provider parameters affect the image request prefix. No chat history, Agent session, or workspace instruction contributes to it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This version accepts text and reference-image input only; uploaded video inputs and audio generation require separate adapters.
- Capability configuration is a declaration, not a connectivity or entitlement test. An invalid key can still be saved; a provider rejection is shown on submission.
- Page drafts, the remembered service, and the remembered parameters are browser-memory state. Retained Host request history survives a reload, but active streams do not reconnect or resubmit.
- English is the fallback for UI locales without a dedicated dictionary.

<a id="dev-note"></a>
### Dev Note

None.
