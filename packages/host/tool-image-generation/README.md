---
description: "Configured image generation in a general-purpose conversation, with owner-turn authorization and durable image results."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-generation

English | [中文](README.zh.md)

## Summary

This plugin adds image generation to ordinary conversations without using an image-only model as the chat route. Settings select an existing Direct AI image service or create one with write-only credentials. A scoped tool calls the trusted provider only during an owner-driven conversation turn, and the Client displays retained image attachments in that conversation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Open **Settings → Models → Conversation images**. Create an OpenAI Images service or choose an existing configured image service. **Save and use for conversation images** saves the service and then its default reference; if the second write is not confirmed, reload and select the saved service instead of creating it again. **Disable conversation images** clears the reference. Chat providers remain configured separately above; their image-input checkbox does not enable image generation. No existing model or credential is migrated automatically.

Select the **Personal chat** preset in a new conversation and describe the image you want. Its chat model must support tool calls. The preset uses a general-purpose complete persona, suppresses runtime and workspace instructions, and removes inherited coding tools while keeping its local image tool. Existing coding presets remain available. Generated images are displayed directly and remain available on history reload through the normal attachment store.

The aiyoyoo shortcut fills `https://www.aiyoyoo.com/v1` and `gpt-image-2`. Its [public directory](https://www.aiyoyoo.com/api/v1/llm-pricing/models) lists this model in the native and upscaled image groups, and its [published console copy](https://www.aiyoyoo.com/assets/index-BdAdvWz0.js) describes a separate `/v1/images/generations` endpoint. This is not a live entitlement or successful paid-call check. The key's account group determines routing; local labels never change it. Configure the exact model authorized for your key.

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host root service owns the volatile `defaultServiceId` settings reference. Only Host-stamped owner browser input admits an image call for its exact live Agent and turn. Foreign input blocks further calls for that turn; missing identity, background-only turns and delegated Agents fail before provider dispatch. Authorization is checked by execution, not merely by hiding the tool. Direct AI remains the owner of saved endpoints, immutable credential pointers, limits, non-retrying HTTP and provider history. Its trusted non-Remote image method returns a run id and independent attachment references only after completion is saved.

The scoped `./tool` entry accepts only a prompt, not a URL, credential, model override or provider arguments. Tool input and safe results are recorded in Session history; the run id correlates that result with Direct AI history. The two histories are not one transaction. If completion cannot be retained, provider billing may already have occurred: do not automatically retry. Cancellation stops local waiting and drains owned work, but cannot undo an accepted provider job. The Settings footer and keyed image-tool renderer register through existing slots; image presentation uses the shared authorized gallery Factory.

<a id="model-experience"></a>
## Model Experience

### Image generation

#### What the model sees

The [`generate_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-image-generation) adds its purpose and one `prompt` parameter to the model request. The personal persona adds a short general-purpose instruction without workspace or coding guidance. Successful results contain a concise summary and durable image references, not base64 or provider download URLs. Image-capable chat routes may receive attachment-derived image inputs; routes explicitly declared text-only receive the existing text projection. Unknown input capabilities must be configured accurately. No credentials enter tool arguments, content or presentation metadata.

#### Token effect

The tool declaration, personal persona, prompt and result summary contribute model input. A generation request adds provider work that may be billed separately from chat; image-capable chat routes can also incur image-input costs when they receive generated attachments.

#### KV Cache effect

The tool declaration and personal persona remain stable while the preset and configuration remain unchanged. New prompts and retained image results extend conversation history; provider-side cache reuse depends on the selected chat route, and the plugin does not guarantee or control it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only synchronous OpenAI Images generation is supported. Image editing, reference-image generation, Gemini output and provider-specific asynchronous image jobs require separate adapters. Unsupported tool-calling chat models cannot automatically invoke generation.
- This plugin does not guarantee upstream model access, image quality, pricing or billing cancellation. Attachment retention follows its storage provider and is independent of Direct AI history pruning; back up attachments together with Sessions. Configuration is owner-only and does not grant shared viewers access to the owner's image key.

<a id="dev-note"></a>
### Dev Note

None.
