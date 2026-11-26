/**
 * Image-generation parameters shared by the workspace composer, its parameter
 * dialog and the retained result card: aspect ratio, resolution, quality,
 * count, and the exact requested size.
 *
 * Sizes converge in place instead of failing at submission: both edges are
 * multiples of 16 between 64 and 3840, the total area stays within 8,294,400
 * pixels, and the longer edge is at most three times the shorter one.
 */
import type { ImageStudioKey } from './locales.ts'

/** Browser key that remembers the last parameter selection on this device. */
export const IMAGE_PARAMS_KEY = 'dsh.directAi.imageParams'

/** Largest image area the image endpoint accepts, in pixels. */
export const IMAGE_MAX_PIXELS = 8_294_400

/** Greatest allowed long-edge to short-edge ratio. */
const MAX_RATIO = 3

/** Smallest selectable edge, in pixels. */
export const IMAGE_MIN_DIMENSION = 64

/** Largest selectable edge, in pixels. */
export const IMAGE_MAX_DIMENSION = 3840

/** Every edge is a multiple of this step. */
export const IMAGE_DIMENSION_STEP = 16

/** Fixed aspect ratios offered beside the source-image ratio; each satisfies the 3:1 bound. */
export const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '9:21', '4:5'] as const

/** Selected aspect ratio; `auto` takes the first reference image's ratio and falls back to 1:1. */
export type AspectRatioId = 'auto' | typeof IMAGE_RATIOS[number]

/** Width divided by height of every fixed ratio. */
const ASPECT_VALUES: Record<Exclude<AspectRatioId, 'auto'>, number> = {
  '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16,
  '3:2': 3 / 2, '2:3': 2 / 3, '21:9': 21 / 9, '9:21': 9 / 21, '4:5': 4 / 5,
}

/** Offered resolutions, named by the long edge they target. */
export const IMAGE_RESOLUTIONS = ['1K', '2K', '3K', '4K'] as const

/** Selected resolution; its target long edge still converges to the area and ratio limits. */
export type ImageResolution = typeof IMAGE_RESOLUTIONS[number]

/** Long edge each resolution targets before convergence. */
const RESOLUTION_LONG_EDGES: Record<ImageResolution, number> = { '1K': 1024, '2K': 2048, '3K': 3072, '4K': 3840 }

/** Offered provider quality values. */
export const IMAGE_QUALITIES = ['low', 'medium', 'high'] as const

/** Provider quality value; it is sent verbatim, so it is not localized. */
export type ImageQuality = typeof IMAGE_QUALITIES[number]

/** Locale key naming one quality in the dialog. */
export type ImageQualityLabelKey = Extract<ImageStudioKey, 'qualityLow' | 'qualityMedium' | 'qualityHigh'>

/** Locale key naming each provider quality. */
export const IMAGE_QUALITY_LABELS: Record<ImageQuality, ImageQualityLabelKey> = {
  low: 'qualityLow', medium: 'qualityMedium', high: 'qualityHigh',
}

/** Selectable image counts per request. */
export const IMAGE_COUNTS = [1, 2, 3, 4] as const

/** Number of images one request asks for. */
export type ImageCount = typeof IMAGE_COUNTS[number]

/** One image size in pixels. */
export interface ImageSize {
  /** Edge along the x axis, a multiple of {@link IMAGE_DIMENSION_STEP}. */
  readonly width: number
  /** Edge along the y axis, a multiple of {@link IMAGE_DIMENSION_STEP}. */
  readonly height: number
}

/** Complete parameter selection used to derive the submitted JSON. */
export interface ImageParams extends ImageSize {
  /** Chosen aspect ratio; `auto` follows the first reference image. */
  readonly ratio: AspectRatioId
  /** Chosen resolution target for the long edge. */
  readonly resolution: ImageResolution
  /** Provider quality value. */
  readonly quality: ImageQuality
  /** Images requested in one submission. */
  readonly count: ImageCount
  /** Whether editing one edge derives the other from the current ratio. */
  readonly lockRatio: boolean
}

/** Selection shown when nothing was remembered: square, 1K, medium quality, one image. */
export const DEFAULT_IMAGE_PARAMS: ImageParams = {
  ratio: '1:1', resolution: '1K', quality: 'medium', count: 1,
  width: 1024, height: 1024, lockRatio: true,
}

/** Round to the nearest multiple of the step. */
function snap(value: number): number {
  return Math.round(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP
}

/** Round down to a multiple of the step, keeping the value from growing past a bound. */
function snapDown(value: number): number {
  return Math.floor(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP
}

/** Snap one edge and hold it between the dimension bounds. */
function bounded(value: number): number {
  const snapped = snap(value)
  if (!Number.isFinite(snapped)) return IMAGE_MIN_DIMENSION
  return Math.min(IMAGE_MAX_DIMENSION, Math.max(IMAGE_MIN_DIMENSION, snapped))
}

/**
 * Converge an arbitrary pair of edges to the provider-admissible range.
 * The shorter edge is preserved where possible: an over-wide size loses width
 * before it loses height, and an over-large area scales both edges together.
 * @param width - requested width in pixels.
 * @param height - requested height in pixels.
 * @returns the closest size with stepped edges, at most 3:1 and within the area limit.
 */
export function constrainSize(width: number, height: number): ImageSize {
  let resultWidth = bounded(width)
  let resultHeight = bounded(height)
  if (resultWidth > MAX_RATIO * resultHeight) {
    resultWidth = Math.max(IMAGE_MIN_DIMENSION, snapDown(MAX_RATIO * resultHeight))
  }
  if (resultHeight > MAX_RATIO * resultWidth) {
    resultHeight = Math.max(IMAGE_MIN_DIMENSION, snapDown(MAX_RATIO * resultWidth))
  }
  if (resultWidth * resultHeight > IMAGE_MAX_PIXELS) {
    const scale = Math.sqrt(IMAGE_MAX_PIXELS / (resultWidth * resultHeight))
    resultWidth = Math.max(IMAGE_MIN_DIMENSION, snapDown(resultWidth * scale))
    resultHeight = Math.max(IMAGE_MIN_DIMENSION, snapDown(resultHeight * scale))
  }
  return { width: resultWidth, height: resultHeight }
}

/**
 * Size one aspect ratio at a target long edge, converged to the limits.
 * @param aspect - width divided by height; non-positive values fall back to a square.
 * @param longEdge - target length of the longer edge in pixels.
 * @returns the converged size.
 */
function sizeForAspect(aspect: number, longEdge: number): ImageSize {
  if (!Number.isFinite(aspect) || aspect <= 0) return constrainSize(longEdge, longEdge)
  return aspect >= 1
    ? constrainSize(longEdge, Math.round(longEdge / aspect))
    : constrainSize(Math.round(longEdge * aspect), longEdge)
}

/**
 * Resolve the width-to-height ratio the current selection describes.
 * @param params - current selection.
 * @param reference - first attached reference image's pixels, when one exists.
 * @returns the fixed ratio, the reference ratio, or the current size's own ratio.
 */
function currentAspect(params: ImageParams, reference?: ImageSize): number {
  if (params.ratio !== 'auto') return ASPECT_VALUES[params.ratio]
  if (reference !== undefined && reference.width > 0 && reference.height > 0) {
    return reference.width / reference.height
  }
  return params.width / Math.max(1, params.height)
}

/**
 * Size a resolution target.
 * @param ratio - selected aspect ratio; `auto` follows the reference or 1:1.
 * @param resolution - selected long-edge target.
 * @param reference - first attached reference image's pixels, when one exists.
 * @returns the converged size at that ratio and resolution.
 */
export function deriveSize(ratio: AspectRatioId, resolution: ImageResolution, reference?: ImageSize): ImageSize {
  const aspect = ratio === 'auto'
    ? reference === undefined || reference.width <= 0 || reference.height <= 0
      ? 1
      : reference.width / reference.height
    : ASPECT_VALUES[ratio]
  return sizeForAspect(aspect, RESOLUTION_LONG_EDGES[resolution])
}

/**
 * Choose an aspect ratio and re-derive the size at the current resolution.
 * @param params - current selection.
 * @param ratio - ratio the user chose.
 * @param reference - first attached reference image's pixels, when one exists.
 * @returns the selection with the derived size.
 */
export function selectRatio(params: ImageParams, ratio: AspectRatioId, reference?: ImageSize): ImageParams {
  return { ...params, ratio, ...deriveSize(ratio, params.resolution, reference) }
}

/**
 * Choose a resolution and re-derive the long edge, keeping the current ratio.
 * @param params - current selection.
 * @param resolution - resolution the user chose.
 * @param reference - first attached reference image's pixels, when one exists.
 * @returns the selection with the derived size.
 */
export function selectResolution(params: ImageParams, resolution: ImageResolution, reference?: ImageSize): ImageParams {
  return {
    ...params, resolution,
    ...sizeForAspect(currentAspect(params, reference), RESOLUTION_LONG_EDGES[resolution]),
  }
}

/**
 * Edit one edge, deriving the other while the ratio is locked.
 * The locked edge follows the current ratio; the unlocked edge keeps its value
 * and both edges converge together when the pair exceeds a limit.
 * @param params - current selection.
 * @param edge - edge the user typed.
 * @param value - typed length in pixels.
 * @param reference - first attached reference image's pixels, when one exists.
 * @returns the selection with the converged size.
 */
export function editDimension(
  params: ImageParams, edge: 'width' | 'height', value: number, reference?: ImageSize,
): ImageParams {
  const aspect = currentAspect(params, reference)
  const typed = bounded(value)
  if (edge === 'width') {
    const height = params.lockRatio ? bounded(typed / aspect) : params.height
    return { ...params, ...constrainSize(typed, height) }
  }
  const width = params.lockRatio ? bounded(typed * aspect) : params.width
  return { ...params, ...constrainSize(width, typed) }
}

/**
 * Set the ratio lock without changing the current size.
 * @param params - current selection.
 * @param lockRatio - whether editing one edge derives the other.
 * @returns the selection with the requested lock.
 */
export function setRatioLock(params: ImageParams, lockRatio: boolean): ImageParams {
  return { ...params, lockRatio }
}

/**
 * Choose the number of images.
 * @param params - current selection.
 * @param count - requested count.
 * @returns the selection with the count.
 */
export function selectCount(params: ImageParams, count: ImageCount): ImageParams {
  return { ...params, count }
}

/**
 * Choose the provider quality.
 * @param params - current selection.
 * @param quality - requested quality.
 * @returns the selection with the quality.
 */
export function selectQuality(params: ImageParams, quality: ImageQuality): ImageParams {
  return { ...params, quality }
}

/**
 * Serialize the selection as the request's `parametersJson`.
 * @param params - current selection.
 * @returns JSON text carrying `size`, `quality` and `n`, with the size as `WxH`.
 */
export function imageParamsJson(params: ImageParams): string {
  return JSON.stringify({ size: `${params.width}x${params.height}`, quality: params.quality, n: params.count })
}

/** One of the fixed ratios, or the default when the stored value is not one of them. */
function aspectRatioOf(value: unknown): AspectRatioId {
  if (value === 'auto') return 'auto'
  return typeof value === 'string' && (IMAGE_RATIOS as readonly string[]).includes(value)
    ? value as AspectRatioId
    : DEFAULT_IMAGE_PARAMS.ratio
}

/** One of the offered resolutions. */
function resolutionOf(value: unknown): ImageResolution {
  return typeof value === 'string' && (IMAGE_RESOLUTIONS as readonly string[]).includes(value)
    ? value as ImageResolution
    : DEFAULT_IMAGE_PARAMS.resolution
}

/** One of the provider qualities. */
function qualityOf(value: unknown): ImageQuality {
  return typeof value === 'string' && (IMAGE_QUALITIES as readonly string[]).includes(value)
    ? value as ImageQuality
    : DEFAULT_IMAGE_PARAMS.quality
}

/** One of the offered counts. */
function countOf(value: unknown): ImageCount {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= IMAGE_COUNTS.length
    ? value as ImageCount
    : DEFAULT_IMAGE_PARAMS.count
}

/** Read one JSON object without trusting its field types. */
function objectOf(value: unknown): object | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Read a member of a narrowed JSON object. */
function field(record: object, key: string): unknown {
  return key in record ? Reflect.get(record, key) : undefined
}

/**
 * Read the parameter selection this browser remembered last.
 * @returns the stored selection with its size converged, or undefined when none is usable.
 */
export function storedImageParams(): ImageParams | undefined {
  let parsed: unknown
  try {
    const text = window.localStorage.getItem(IMAGE_PARAMS_KEY)
    if (text === null) return undefined
    parsed = JSON.parse(text)
  } catch (_storageUnavailable) {
    return undefined
  }
  const record = objectOf(parsed)
  if (record === undefined) return undefined
  const width = field(record, 'width')
  const height = field(record, 'height')
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  const lockRatio = field(record, 'lockRatio')
  return {
    ratio: aspectRatioOf(field(record, 'ratio')),
    resolution: resolutionOf(field(record, 'resolution')),
    quality: qualityOf(field(record, 'quality')),
    count: countOf(field(record, 'count')),
    ...constrainSize(width, height),
    lockRatio: typeof lockRatio === 'boolean' ? lockRatio : DEFAULT_IMAGE_PARAMS.lockRatio,
  }
}

/**
 * Remember the parameter selection for the next visit.
 * @param params - selection to store.
 */
export function rememberImageParams(params: ImageParams): void {
  try {
    window.localStorage.setItem(IMAGE_PARAMS_KEY, JSON.stringify(params))
  } catch (_storageUnavailable) {
    // A browser that refuses storage keeps the selection for this page only.
  }
}
