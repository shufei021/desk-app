/**
 * Mask editing for the image workspace: an opaque PNG mask whose erased regions
 * stay transparent, the circular brush that erases them, and the checks that
 * refuse an empty mask and hand the canvas PNG to `uploadReference`.
 *
 * Pixel work stays in memory and this module owns no UI copy: callers pass
 * {@link MaskEditorMessages}, which the locale dictionary fills.
 */

/** Smallest brush radius, in displayed pixels, offered by the mask editor. */
export const MASK_BRUSH_MIN = 12
/** Largest brush radius, in displayed pixels, offered by the mask editor. */
export const MASK_BRUSH_MAX = 180
/** Brush radius selected when the editor opens. */
export const MASK_BRUSH_DEFAULT = 70

/** Opaque mask paint; only erased pixels become editable in the provider request. */
const OPAQUE_MASK = '#000'
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const MASK_FILE_SUFFIX = '-mask.png'
const MASK_FILE_FALLBACK = 'mask.png'
const FILE_EXTENSION = /\.[^./\\]+$/

/**
 * Displayable copy the mask editor needs, supplied by the caller so this module
 * ships no user-visible text.
 */
export interface MaskEditorMessages {
  /** Dialog heading. */
  title: string
  /** Accessible name of the reference image shown under the mask. */
  sourceAlt: string
  /** Accessible name of the drawing surface. */
  canvas: string
  /** Label of the brush-radius slider. */
  brush: string
  /** Label of the control restoring the untouched mask. */
  reset: string
  /** Label of the control keeping the erased mask. */
  apply: string
  /** Shown when nothing was erased, so the mask would leave no editable region. */
  empty: string
  /** Shown when the image pixels or the canvas cannot be used. */
  loadFailed: string
  /** Shown when the produced mask could not be stored as a reference. */
  saveFailed: string
  /** Accessible name of the dialog close control. */
  close: string
}

/**
 * Report whether any pixel is not fully opaque.
 * @param image - mask pixels; alpha is the fourth channel of each pixel.
 * @returns true when at least one pixel has alpha below 255.
 */
export function hasTransparentPixel(image: ImageData): boolean {
  const { data } = image
  for (let offset = 3; offset < data.length; offset += 4) {
    if ((data[offset] ?? 0) < 255) return true
  }
  return false
}

/**
 * Erase one circular region so the provider treats it as editable.
 * @param context - 2D context of the mask canvas.
 * @param x - circle center on the canvas X axis, in canvas pixels.
 * @param y - circle center on the canvas Y axis, in canvas pixels.
 * @param radius - erased circle radius in canvas pixels.
 */
export function eraseAt(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  context.globalCompositeOperation = 'destination-out'
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fill()
}

/**
 * Paint the untouched mask: an opaque black surface of the given size.
 * @param context - 2D context of the mask canvas.
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 */
export function fillMask(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.globalCompositeOperation = 'source-over'
  context.globalAlpha = 1
  context.fillStyle = OPAQUE_MASK
  context.fillRect(0, 0, width, height)
}

/**
 * Replace the canvas pixels with a mask kept from an earlier edit.
 * @param context - 2D context of the mask canvas.
 * @param image - loaded mask PNG; its size is the canvas size.
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 */
export function drawMask(context: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number): void {
  context.globalCompositeOperation = 'source-over'
  context.globalAlpha = 1
  context.clearRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
}

/**
 * Encode the canvas as a mask PNG and read the pixels that decide whether it erases anything.
 * @param canvas - mask canvas sized to the reference image.
 * @returns the PNG data URL and its pixels, or undefined when the canvas cannot provide them.
 */
export function readMask(canvas: HTMLCanvasElement): { dataUrl: string; pixels: ImageData } | undefined {
  if (canvas.width === 0 || canvas.height === 0) return undefined
  const context = canvas.getContext('2d')
  if (context === null) return undefined
  let pixels: ImageData
  try {
    pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  } catch (_unreadableMaskPixels) {
    // A canvas that cannot expose its pixels cannot prove the mask erases anything.
    return undefined
  }
  return { dataUrl: canvas.toDataURL('image/png'), pixels }
}

/**
 * Decode the mask PNG back into a file accepted by `uploadReference`.
 * @param dataUrl - PNG data URL produced by {@link readMask}.
 * @param name - file name shown in the stored reference.
 * @returns the PNG file, or undefined when the data URL is not base64 PNG.
 */
export function maskFileFromDataUrl(dataUrl: string, name: string): File | undefined {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return undefined
  let binary: string
  try {
    binary = atob(dataUrl.slice(PNG_DATA_URL_PREFIX.length))
  } catch (_invalidBase64Mask) {
    return undefined
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], name, { type: 'image/png' })
}

/**
 * Derive the stored mask file name from the reference image it belongs to.
 * @param sourceName - original reference file name, empty when the Host kept none.
 * @returns the source name without its extension plus a mask suffix.
 */
export function maskFileName(sourceName: string): string {
  const base = sourceName.replace(FILE_EXTENSION, '').trim()
  return base === '' ? MASK_FILE_FALLBACK : `${base}${MASK_FILE_SUFFIX}`
}
