/** Host companion for the workspace-independent direct AI page. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DirectPageConfig } from './types.ts'

/** Initial navigation preference, synchronized without provider credentials. */
export type Config = DirectPageConfig

/** New page instances open directly unless the profile disables the preference. */
export const Config = z.object({ openOnStart: z.boolean().default(true).volatile() })

/**
 * Register the browser feature through the composed profile.
 * @param _ctx - Host plugin context.
 * @param _config - validated navigation preference, consumed by the browser companion.
 */
export function apply(_ctx: Context, _config: Config): void {}
