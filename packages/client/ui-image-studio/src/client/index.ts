/**
 * Image workspace browser plugin: its main panel, sidebar entry, and the
 * conversation input mode bar move between the image workspace and the Agent
 * conversation without starting one.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement, type ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import { DirectController, pageFace } from '@deepseek-ai/dsh-client-direct-ai-client'
import { createRemoteAssetLibrary } from './assets.ts'
import { ImageStudio, type ImageStudioInjected } from './ImageStudio.tsx'
import { ModeBar, type ModeBarMode } from './ModeBar.tsx'
import { NS, en, zh, type ImageStudioKey } from './locales.ts'

const IMAGE_STUDIO_ID = 'image-studio' as MainPanelId
/** Browser-only record of the chosen image service; it never contains a credential. */
const IMAGE_STUDIO_SERVICE_KEY = 'dsh.directAi.imageStudio.serviceId'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image workspace copy. */
    imageStudio: ImageStudioKey
  }
}

/** Dependencies of the image workspace; no Agent or workspace service is required. */
export const inject = ['slots', 'locale', 'remote', 'remote.directAi', 'remote.workspaceAssets', 'remoteAccess', 'layout']

function ImageStudioIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return createElement(IconSparkleRegular, { size })
}

/**
 * Mount the image workspace beside the existing Agent application.
 * @param ctx - browser context supplying generated Remote and presentation services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  const t = ctx.locale.bind(NS)
  // One workspace-backed asset library serves this workspace for the plugin's lifetime.
  const assetLibrary = createRemoteAssetLibrary(ctx.remote.workspaceAssets)
  ctx.remoteAccess.whenAccess('directAi/catalog', function* () {
    const controller = new DirectController(ctx.remote.directAi)
    yield () => controller.dispose()
    const imageService = createSnapshotStore<ServiceId | null>(null, { persist: { name: IMAGE_STUDIO_SERVICE_KEY } })
    const imageFace: ImageStudioInjected = {
      ...pageFace(controller, () => { ctx.layout.selectPanel(null) }, (serviceId) => {
        imageService.set(serviceId)
        controller.select(serviceId)
      }),
      assetLibrary,
      assistChat: (serviceId, system, prompt, onText, signal) =>
        controller.assistChat(serviceId, system, prompt, onText, signal),
      variantRun: (request, signal) => controller.openStream(request, signal),
    }
    yield ctx.slots.inject('main', () => {
      const dispose = ctx.slots.register({ name: 'main', key: IMAGE_STUDIO_ID, locale: NS, inject: () => imageFace }, ImageStudio)
      return () => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === IMAGE_STUDIO_ID) ctx.layout.selectPanel(null)
        dispose()
      }
    })
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: IMAGE_STUDIO_ID, order: -9, label: () => t('imageStudio'),
    }, ImageStudioIcon))
    yield ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'image-studio-mode', order: -20, locale: NS,
    }, function ChatModeBar({ t: translate }: PropsLocale<'imageStudio'>): ReactNode {
      const onSelect = (mode: ModeBarMode): void => {
        if (mode === 'image') ctx.layout.selectPanel(IMAGE_STUDIO_ID)
      }
      return createElement(ModeBar, { mode: 'chat', onSelect, t: translate })
    }))
    const refreshImages = async (): Promise<void> => {
      await controller.refresh()
      const services = controller.catalog.getSnapshot().services.filter(service => service.capability === 'image' && service.configured)
      const remembered = imageService.getSnapshot()
      const chosen = services.find(service => service.id === remembered) ?? services[0]
      if (chosen !== undefined) controller.select(chosen.id)
    }
    yield ctx.on('connection/reset', () => { void refreshImages() })
    yield ctx.layout.panelInfo.subscribe(() => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === IMAGE_STUDIO_ID) void refreshImages()
    })
    void refreshImages()
  })
}
