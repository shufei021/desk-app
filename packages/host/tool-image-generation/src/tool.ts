/** Scoped model-facing image generation; the Host service owns authority and the saved provider selection. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment/types'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type {} from './index.ts'

/** Loader diagnostic name. */
export const name = 'tool-image-generation'
/** Authority and provider selection are injected rather than inferred from the chat model. */
export const inject = ['tools', 'imageGeneration']

const imageSchema = {
  type: 'object', additionalProperties: false, properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false,
      properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
  },
} as const

/**
 * Register the non-retrying image tool in this preset's scope.
 * @param ctx - Scoped tool and trusted image-generation service registrations.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate images from a description using the configured image service and show them in this conversation. A call may incur provider charges; do not automatically retry a failed or cancelled call.',
    parameters: { prompt: { type: 'string', required: true, description: 'Describe the requested image, including any user-specified style and composition.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        runId: { type: 'string', required: true },
        service: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, name: { type: 'string', required: true }, model: { type: 'string', required: true },
        }, required: true },
        images: { type: 'array', items: imageSchema, required: true },
      } },
      render: (_args, value) => [
        { type: 'text', text: `Generated ${value.images.length} image(s) with ${value.service.name} (${value.service.model}). Images are attached to this conversation. Request record: ${value.runId}.` },
        ...value.images.map(image => ({ type: 'image' as const,
          attachment: { ...image, attachmentId: brandString<AttachmentId>(image.attachmentId) } })),
      ],
      presentationMeta: (_args, value) => ({ runId: value.runId, serviceName: value.service.name, model: value.service.model }),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new ToolContextUnavailableError('generate_image requires an active conversation.')
      if (!args.prompt.trim()) throw new ToolArgsError(['prompt must describe the requested image'])
      return ctx.imageGeneration.generate(exec.agent, args.prompt, exec.signal)
    },
  }))
}
