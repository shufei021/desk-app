/** Personal-chat Agents retain the image capability while hiding inherited coding tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

/** Loader diagnostic name. */
export const name = 'personal-chat-tools'
/** Agent creation is scope-filtered to the preset that owns this registration. */
export const inject = ['tools', 'agents']

/**
 * Restrict each Agent after its preset tools become ancestors of its own scope.
 * @param ctx - Preset-scoped plugin context; no global tool registry is changed.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    const mask = agent.ctx.plugin({
      inject: ['tools'],
      apply: (scoped: Context) => { scoped.tools.restrict({ allow: ['generate_image'] }) },
    })
    ctx.effect(() => () => mask.dispose())
    await mask
  })
}
