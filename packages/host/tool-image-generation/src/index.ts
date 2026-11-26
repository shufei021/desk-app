/** Owner-turn authorization and explicit image-service selection, independent of the chat model route. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-direct-ai'
import type { GeneratedImageResult, ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'

/** Live default service reference; empty disables generation without changing the chat route. */
export interface Config {
  /** Saved image service identity; an empty value disables conversation image generation. */
  defaultServiceId: Volatile<string>
}

/** Expected configuration or authority failure; provider errors retain their original safe codes. */
export class ImageGenerationError extends HarnessError {
  /** @param message - Safe corrective action. @param code - Stable failure classification. */
  constructor(message: string, code: 'IMAGE_GENERATION_FORBIDDEN' | 'IMAGE_GENERATION_NOT_CONFIGURED') {
    super(message, code)
    this.name = 'ImageGenerationError'
  }
}

interface TurnAuthority { turn: number; state: 'unknown' | 'allowed' | 'blocked' }

/** Only the browser's Host-stamped owner request can authorize a billable image call. */
function ownerInput(message: UserMessage): boolean {
  const source = message.source
  if (source.kind !== 'user' || !('rpcId' in source) || typeof source.rpcId !== 'string') return false
  return !('principal' in source) || (typeof source.principal === 'object' && source.principal !== null
    && 'kind' in source.principal && source.principal.kind === 'owner')
}

/** Explicit foreign input revokes image authority for the rest of its turn. */
function foreignInput(message: UserMessage): boolean {
  return 'principal' in message.source && !ownerInput(message)
}

declare module '@deepseek-ai/cordis' {
  interface Context { imageGeneration: ImageGeneration }
}

/** Trusted Host service; browser clients change its reference through owner-authenticated Settings only. */
export default class ImageGeneration extends Service {
  static inject = ['agents', 'attachments']
  static Config = Schema.object({ defaultServiceId: Schema.string().default('').volatile() })
  private readonly turns = new WeakMap<Agent, TurnAuthority>()
  private closed = false

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'imageGeneration')
    ctx.effect(() => () => { this.closed = true })
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      const previous = this.turns.get(agent)
      const state = previous?.turn === turn ? previous.state : 'unknown'
      this.turns.set(agent, { turn, state: state === 'blocked' || decision.messages.some(foreignInput) ? 'blocked'
        : state === 'allowed' || decision.messages.some(ownerInput) ? 'allowed' : 'unknown' })
      return decision
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.turns.delete(agent) }, { global: true })
  }

  /**
   * Generate once using the current explicit service after rechecking the exact live owner-driven turn.
   * @param agent - Agent supplied by the tool executor, never a caller-selected Session id.
   * @param prompt - Image description; no credentials, route or arbitrary provider arguments are accepted.
   * @param signal - Tool cancellation; local cancellation cannot undo upstream billing.
   * @returns Independently retained image attachments and the provider-history correlation id.
   */
  async generate(agent: Agent, prompt: string, signal: AbortSignal): Promise<GeneratedImageResult> {
    signal.throwIfAborted()
    if (this.closed) throw new ImageGenerationError('Image generation is unavailable while its service is closing.', 'IMAGE_GENERATION_FORBIDDEN')
    const boundary = this.ctx.agents.turnBoundaryOf(agent.session)
    const authority = this.turns.get(agent)
    if (this.ctx.agents.get(agent.id) !== agent || agent.session.header.parentSession !== undefined
      || agent.session.header.origin === 'subagent' || boundary.openTurnStartSeq === null
      || authority?.turn !== boundary.lastTurn || authority.state !== 'allowed') {
      throw new ImageGenerationError('Image generation requires an active owner chat request; shared and background turns cannot use the saved image key.',
        'IMAGE_GENERATION_FORBIDDEN')
    }
    const id = this.config.defaultServiceId.get().trim()
    if (!id) throw new ImageGenerationError('Configure a default image service under Settings → Models → Conversation images before requesting images.',
      'IMAGE_GENERATION_NOT_CONFIGURED')
    const provider = this.ctx.get('directAi')
    if (provider === undefined) throw new ImageGenerationError('Image generation is unavailable in this profile; configure its image provider before trying again.',
      'IMAGE_GENERATION_NOT_CONFIGURED')
    try { return await provider.generateImage(id as ServiceId, prompt, signal) }
    catch (error) {
      if (error instanceof HarnessError && error.code === 'DIRECT_AI_STORAGE_FAILED') {
        throw new HarnessError('Image output could not be saved safely. The provider may already have charged this request; it was not retried. Check request history before trying again.',
          'DIRECT_AI_STORAGE_FAILED', { cause: error })
      }
      throw error
    }
  }
}
