/**
 * Visual-style suffixes for one comparison batch: each style appends fixed
 * Chinese prompt text to the user's description.
 *
 * The suffixes are model prompts, not user-visible UI copy, so translating them
 * would change what the provider receives. Only the style names come from the
 * locale dictionary through the panel's `t` seat.
 */
import type { ImageStudioKey } from './locales.ts'

/** Style a batch may append, in panel order. */
export type VariantStyleId = 'photo' | 'cinematic' | 'illustration' | 'render3d' | 'watercolor'

/** Offered styles, in panel order and in the order a batch runs them. */
export const VARIANT_STYLES: readonly VariantStyleId[] = ['photo', 'cinematic', 'illustration', 'render3d', 'watercolor']

/** Style suffix appended to the description; a leading comma continues the sentence. */
const VARIANT_SUFFIXES: Record<VariantStyleId, string> = {
  photo: '，写实摄影质感，自然光',
  cinematic: '，电影感画面，戏剧性布光，宽银幕构图',
  illustration: '，手绘插画风格，清晰线条，柔和配色',
  render3d: '，3D 渲染质感，体积光，细腻材质',
  watercolor: '，水彩画风格，晕染笔触，纸感留白',
}

/** Locale key naming one style in the panel's checkbox list and result columns. */
export const VARIANT_STYLE_LABELS: Record<VariantStyleId, ImageStudioKey> = {
  photo: 'variantStylePhoto',
  cinematic: 'variantStyleCinematic',
  illustration: 'variantStyleIllustration',
  render3d: 'variantStyleRender3d',
  watercolor: 'variantStyleWatercolor',
}

/**
 * Compose the provider prompt for one style.
 * @param base - user description; surrounding whitespace is dropped so the suffix continues cleanly.
 * @param styleId - style whose suffix this variant appends.
 * @returns the description followed by the style suffix, which is exactly what the request carries.
 */
export function variantPrompt(base: string, styleId: VariantStyleId): string {
  return `${base.trim()}${VARIANT_SUFFIXES[styleId]}`
}
