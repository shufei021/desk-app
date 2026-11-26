/** Conversation-image configuration and image Tool presentation use existing settings and gallery extensions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { imageResultDefinition } from './image-result-node.ts'
import { ImageResultNode } from './ImageResultNode.tsx'
import { ImageSettings, type ImageSettingsInjected } from './ImageSettings.tsx'
import { GeneratedImageTool } from './GeneratedImageTool.tsx'
import { ImageSettingsController, type ImageGenerationSettings } from './state.ts'
import { en, zh, type ImageGenerationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image configuration and generated-image outcomes in a conversation. */
    imageGeneration: ImageGenerationKey
  }
}

/** Root settings sources and generated namespaces; Tool image loading comes from the owner. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.directAi', 'remote.settings', 'uiConversation']

/** @param ctx - browser plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('imageGeneration', { en, zh }))
  const form = ctx.configForms.get<ImageGenerationSettings>('image-generation')
  const controller = new ImageSettingsController(ctx.remote, form)
  ctx.effect(() => () => controller.dispose())
  const face: ImageSettingsInjected = { hooks: { state: controller.state, settings: form },
    refresh: () => controller.refresh(), choose: id => controller.choose(id), save: input => controller.save(input) }
  ctx.effect(() => ctx.configForms.whileServed(['image-generation'], () => ctx.slots.inject('settings.models.footer', () => {
    void controller.refresh()
    return ctx.slots.register({ name: 'settings.models.footer', id: 'conversation-images', locale: 'imageGeneration',
      inject: () => face }, ImageSettings)
  })))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'generate_image', locale: 'imageGeneration',
  }, GeneratedImageTool))
  ctx.uiConversation.events.register(imageResultDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'generated-images', locale: 'imageGeneration',
  }, ImageResultNode))
  ctx.effect(() => ctx.on('connection/reset', () => { void controller.refresh() }))
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { void controller.refresh() }))
}
