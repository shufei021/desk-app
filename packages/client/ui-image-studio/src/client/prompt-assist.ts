/**
 * Prompt-assistant contract: the system instruction sent with every expansion
 * request, and the browser preference remembering which chat service produced it.
 *
 * The instruction is a model prompt, not user-visible UI copy: translating it
 * would change what the model receives, so it lives here instead of the locale
 * dictionary. The panel's labels come from `locales.ts` through the `t` seat.
 */
import type { ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'

/** Browser key remembering the chat service the assistant used last. */
export const PROMPT_ASSIST_SERVICE_KEY = 'dsh.directAi.promptAssistService'

/**
 * System instruction for one expansion request.
 *
 * It asks for a single paragraph a text-to-image model can use unchanged:
 * subject, composition, light, material, style and quality, without commentary,
 * numbering or quotes, within 600 characters.
 */
export const PROMPT_ASSIST_SYSTEM = [
  '你是文生图提示词助手。根据用户给出的简短描述，只输出一段可直接用于文生图的中文提示词。',
  '提示词必须包含主体、构图、光线、材质、风格和画质六个方面。',
  '不要解释，不要编号，不要使用引号、列表或标题，不要输出提示词以外的任何内容。',
  '总长度不超过 600 字。',
].join('\n')

/**
 * Read the chat service the prompt assistant used last.
 * @returns the remembered service id, or undefined when none was stored.
 */
export function rememberedPromptAssistService(): string | undefined {
  try {
    return window.localStorage.getItem(PROMPT_ASSIST_SERVICE_KEY) ?? undefined
  } catch (_storageUnavailable) {
    return undefined
  }
}

/**
 * Remember the chat service for the next prompt-assistant visit.
 * @param serviceId - configured chat service the user chose.
 */
export function rememberPromptAssistService(serviceId: ServiceId): void {
  try {
    window.localStorage.setItem(PROMPT_ASSIST_SERVICE_KEY, serviceId)
  } catch (_storageUnavailable) {
    // A browser that refuses storage keeps the choice for this page only.
  }
}

/**
 * List the services the prompt assistant may call.
 * @param services - Host-confirmed service views.
 * @returns configured chat services in catalog order.
 */
export function chatServices(services: readonly ServiceView[]): ServiceView[] {
  return services.filter(service => service.capability === 'chat' && service.configured)
}
