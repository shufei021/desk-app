/**
 * Deterministic parameter suggestions derived from the typed image description,
 * its reference count and the selected preset.
 *
 * The rules are intentionally conservative: they only rewrite the selection when
 * the description states a composition, quality or quantity, and every suggestion
 * is a complete parameter selection the composer can apply without further input.
 */
import type { ImageStudioKey } from './locales.ts'
import {
  DEFAULT_IMAGE_PARAMS, type ImageCount, type ImageParams, type ImageQuality, type ImageResolution,
} from './image-params.ts'
import type { PromptPresetId } from './prompt-presets.ts'

/** Aspect ratio a suggestion selects; the source-image ratio is never suggested. */
export type SuggestedRatio = Exclude<ImageParams['ratio'], 'auto'>

/** Why a suggestion differs from the current selection; resolves to one locale key. */
export type SuggestionReason =
  | 'preset'
  | 'reference'
  | 'portrait'
  | 'landscape'
  | 'ultraWide'
  | 'square'
  | 'qualityHigh'
  | 'qualityLow'
  | 'countMany'
  | 'countCompare'
  | 'balanced'

/** Locale key carrying the user-visible reason for each suggestion source. */
export const SUGGESTION_REASON_KEYS: Record<SuggestionReason, ImageStudioKey> = {
  preset: 'suggestionReasonPreset',
  reference: 'suggestionReasonReference',
  portrait: 'suggestionReasonPortrait',
  landscape: 'suggestionReasonLandscape',
  ultraWide: 'suggestionReasonUltraWide',
  square: 'suggestionReasonSquare',
  qualityHigh: 'suggestionReasonQualityHigh',
  qualityLow: 'suggestionReasonQualityLow',
  countMany: 'suggestionReasonCountMany',
  countCompare: 'suggestionReasonCountCompare',
  balanced: 'suggestionReasonBalanced',
}

/** Complete suggested selection plus the reason shown beside it. */
export interface ParamSuggestion {
  /** Suggested aspect ratio. */
  readonly ratio: SuggestedRatio
  /** Suggested long-edge target. */
  readonly resolution: ImageResolution
  /** Suggested provider quality. */
  readonly quality: ImageQuality
  /** Suggested number of images. */
  readonly count: ImageCount
  /** Why this selection was suggested. */
  readonly reason: SuggestionReason
}

/** Requested image budget for one submission. */
export interface BudgetEstimate {
  /** Total pixels of one image in millions, rounded to one decimal. */
  readonly megapixels: number
  /** Images the request asks for. */
  readonly images: number
}

/** Compositions stated in the description, checked before quality and quantity words. */
const RATIO_RULES: readonly { readonly pattern: RegExp; readonly ratio: SuggestedRatio; readonly reason: SuggestionReason }[] = [
  { pattern: /全景|21:9/u, ratio: '21:9', reason: 'ultraWide' },
  { pattern: /竖|人像|全身|立绘|手机壁纸|海报竖版/u, ratio: '9:16', reason: 'portrait' },
  { pattern: /横|风景|场景|宽幅|电影|横幅/u, ratio: '16:9', reason: 'landscape' },
  { pattern: /头像|图标|方图|1:1/u, ratio: '1:1', reason: 'square' },
]

/** High-detail words that raise quality and the long edge. */
const HIGH_QUALITY = /4k|印刷|高清|细节/iu

/** Draft or thumbnail words that lower quality and the long edge. */
const LOW_QUALITY = /草图|快速|缩略/u

/** Quantity words asking for several alternatives. */
const MANY_COUNT = /方案|变体|几张|多个/u

/** Quantity words asking for a smaller comparison set. */
const COMPARE_COUNT = /对比|备选/u

/** Read the composition words, falling back to a balanced square. */
function ratioRule(prompt: string): { ratio: SuggestedRatio; reason: SuggestionReason } {
  const matched = RATIO_RULES.find(rule => rule.pattern.test(prompt))
  return matched === undefined ? { ratio: '1:1', reason: 'balanced' } : { ratio: matched.ratio, reason: matched.reason }
}

/** Read the quality words; the default stays at the balanced mid range. */
function qualityRule(prompt: string): { quality: ImageQuality; resolution: ImageResolution; reason?: SuggestionReason } {
  if (HIGH_QUALITY.test(prompt)) return { quality: 'high', resolution: '4K', reason: 'qualityHigh' }
  if (LOW_QUALITY.test(prompt)) return { quality: 'low', resolution: '1K', reason: 'qualityLow' }
  return { quality: 'medium', resolution: '2K' }
}

/** Read the quantity words; one image unless the description asks for alternatives. */
function countRule(prompt: string): { count: ImageCount; reason?: SuggestionReason } {
  if (MANY_COUNT.test(prompt)) return { count: 4, reason: 'countMany' }
  if (COMPARE_COUNT.test(prompt)) return { count: 2, reason: 'countCompare' }
  return { count: 1 }
}

/**
 * Suggest a complete parameter selection for one description.
 * @param prompt - user-authored description; an empty description yields the balanced default.
 * @param references - number of attached reference images.
 * @param preset - selected generation preset; a template preset overrides the description rules.
 * @returns the suggested selection with the locale-independent reason.
 */
export function suggestParams(prompt: string, references: number, preset: PromptPresetId): ParamSuggestion {
  if (preset === 'characterTurnaround') {
    return { ratio: '16:9', resolution: '2K', quality: 'high', count: 1, reason: 'preset' }
  }
  if (preset === 'sceneMultiView') {
    return { ratio: '1:1', resolution: '2K', quality: 'high', count: 1, reason: 'preset' }
  }
  const ratio = ratioRule(prompt)
  const quality = qualityRule(prompt)
  const count = countRule(prompt)
  // A reference image is normally at most 2K on its long edge, so a higher target adds no detail.
  const capped = references > 0 && quality.resolution === '4K'
  const reason = capped
    ? 'reference'
    : quality.reason ?? count.reason ?? ratio.reason
  return {
    ratio: ratio.ratio,
    resolution: capped ? '2K' : quality.resolution,
    quality: quality.quality,
    count: count.count,
    reason,
  }
}

/**
 * Whether two selections already agree on every suggested field.
 * @param suggestion - candidate suggestion.
 * @param params - current selection.
 * @returns true when applying the suggestion would change nothing.
 */
export function sameSelection(suggestion: ParamSuggestion, params: ImageParams): boolean {
  return suggestion.ratio === params.ratio
    && suggestion.resolution === params.resolution
    && suggestion.quality === params.quality
    && suggestion.count === params.count
}

/**
 * Resolve the suggestion worth showing for the current composer state.
 * @param prompt - user-authored description; blank descriptions never suggest.
 * @param references - number of attached reference images.
 * @param preset - selected generation preset.
 * @param params - current selection; undefined means the provider defaults apply.
 * @returns the suggestion, or undefined when the description is blank or already satisfied.
 */
export function pendingSuggestion(
  prompt: string, references: number, preset: PromptPresetId, params: ImageParams | undefined,
): ParamSuggestion | undefined {
  if (prompt.trim() === '') return undefined
  const suggestion = suggestParams(prompt, references, preset)
  return sameSelection(suggestion, params ?? DEFAULT_IMAGE_PARAMS) ? undefined : suggestion
}

/**
 * Estimate the pixels and images one submission requests.
 * @param params - current selection carrying the exact size and count.
 * @returns one image's megapixels rounded to one decimal, and the requested image count.
 */
export function estimateBudget(params: ImageParams): BudgetEstimate {
  return {
    megapixels: Math.round((params.width * params.height) / 1e6 * 10) / 10,
    images: params.count,
  }
}
