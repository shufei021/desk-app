/** Workspace-independent direct AI navigation and owner-only page registration. */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import { DirectController, pageFace } from '@deepseek-ai/dsh-client-direct-ai-client'
import type { DirectPageConfig } from '../types.ts'
import { DirectPage } from './DirectPage.tsx'
import { NS, en, zh, type DirectKey } from './locales.ts'

const PANEL_ID = 'direct-ai' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Direct-provider requests and service configuration. */
    directAi: DirectKey
  }
}

/** Dependencies of the global direct-provider page; no Agent or workspace service is required. */
export const inject = ['slots', 'locale', 'remote', 'remote.directAi', 'remoteAccess', 'layout']

function DirectIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return createElement(IconNewChatOutlineRegular, { size })
}

/**
 * Mount a personal direct-provider page beside the existing Agent application.
 * @param ctx - browser context supplying generated Remote and presentation services.
 * @param config - initial page preference; later changes apply on the next page load.
 */
export function apply(ctx: Context, config: SyncedConfig<DirectPageConfig>): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  const t = ctx.locale.bind(NS)
  ctx.remoteAccess.whenAccess('directAi/catalog', function* () {
    const controller = new DirectController(ctx.remote.directAi)
    yield () => controller.dispose()
    yield ctx.slots.inject('main', () => {
      const dispose = ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => pageFace(controller, () => { ctx.layout.selectPanel(null) }),
      }, DirectPage)
      if (config.openOnStart.get() ?? true) ctx.layout.selectPanel(PANEL_ID)
      return () => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) ctx.layout.selectPanel(null)
        dispose()
      }
    })
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: -10, label: () => t('panel'),
    }, DirectIcon))
    yield ctx.on('connection/reset', () => { void controller.refresh() })
    void controller.refresh()
  })
}
