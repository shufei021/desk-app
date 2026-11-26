---
kind: upgrade-guide
description: "The personal Web build defaults new conversations to Personal chat with separate image-generation settings and disables automatic official-model credential onboarding."
---

# Personal conversations and image services

English | [中文](guide.zh.md)

## Change

The personal Web build opens the conversation rather than Direct AI and defaults new Sessions to **Personal chat**, without coding or workspace instructions. Existing Sessions retain their preset and chat-model selection. Image-only models in **Settings → Models** are not generation services: a separate **Conversation images** section selects the saved image service used by the chat tool. Direct AI remains available as a standalone page. Official-model credential onboarding is disabled.

Direct AI storage writes version 2 and accepts version 1 service records without display annotations; opening old records does not rewrite them. Downgrading after edits is unsupported. Direct and Session image results use independent storage references; no key or model is automatically migrated between configuration domains.

## Migration

1. Back up your Harness home and attachment store before upgrading. Keep the existing personal Desktop home; do not replace it with the official application's directory.
2. Open **Settings → Models → Conversation images**. Create an OpenAI Images service with its own base URL, model ID and key, or select an existing image service. If saving the service succeeds but default selection is unconfirmed, reload and select it rather than creating it again.
3. Use a tool-calling chat model and choose **Personal chat** in a new conversation. Ask for an image and confirm that its result appears in that same conversation. A saved configuration is not proof of upstream access; use a small explicit request and check provider charges.
4. Existing Sessions keep their recorded preset. Switch them deliberately, or create a new Session; keep `standard` and the other coding presets for coding tasks. A previously saved default under `agent-preset-registry.selectedDefault` takes precedence until changed in Settings.
5. To reopen Direct AI initially, set `openOnStart: true` on the `ui-direct-ai` profile row. To restore official Agent credential onboarding, set `credentialOnboarding: true` on `ui-settings-models`. Each patch replaces the row's complete configuration, so preserve other fields you use.
