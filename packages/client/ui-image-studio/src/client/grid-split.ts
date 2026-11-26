/**
 * Browser-side split of a generated contact sheet along its straight white
 * separator lines: threshold selection, antialias expansion, panel bounds and
 * JPEG tiles. Pixel work stays in memory; no Host or Remote call participates.
 * @module @deepseek-ai/dsh-client-ui-direct-ai
 */
import { HarnessError } from '@deepseek-ai/dsh-error'

/** One cropped panel: a JPEG data URL and the file name suggested for it. */
export interface SplitTile {
  /** `data:image/jpeg` URL holding the panel pixels. */
  dataUrl: string
  /** Download file name in reading order, such as `grid-split-1-2.jpg`. */
  name: string
}

/** Displayable failure copy supplied by the caller, so this module owns no UI text. */
export interface GridSplitMessages {
  /** Shown when the image has no usable separator grid. */
  notFound: string
  /** Shown when the source exceeds the accepted side length or pixel budget. */
  tooLarge: string
  /** Shown when the canvas cannot read the source pixels. */
  invalid: string
}

/** White thresholds, tried from the strictest to the widest tolerance. */
const WHITE_CHANNEL_THRESHOLDS = [247, 240, 232] as const
/** Share of a scanline that must be white before it counts as a separator. */
const WHITE_LINE_COVERAGE = 0.72
/** Inclusive width range of one accepted separator line. */
const GRID_LINE_WIDTH_MIN = 1
const GRID_LINE_WIDTH_MAX = 32
/** Fraction of a side excluded at the border, so an image frame is never a separator. */
const GRID_BORDER_INSET_RATIO = 0.01
/** Accepted separator line count per direction: one line splits 2 panels, three split 4. */
const GRID_LINE_COUNT_MIN = 1
const GRID_LINE_COUNT_MAX = 3
/** Smallest accepted panel side; smaller panels usually signal a false line. */
const MIN_PANEL_SIZE = 64
/** Pixels absorbed at each side of a line to carry its antialias transition. */
const FEATHER_MAX = 2
/** Mean and tenth-percentile channel value required of a transition scanline. */
const TRANSITION_MIN_MEAN = 65
const TRANSITION_MIN_CHANNEL = 50
/** Longest accepted source side and largest accepted pixel total. */
const MAX_IMAGE_DIMENSION = 4096
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024
/** JPEG encoding quality of every emitted panel. */
const JPEG_QUALITY = 0.92

const NOT_FOUND_CODE = 'IMAGE_GRID_NOT_FOUND'
const TOO_LARGE_CODE = 'IMAGE_GRID_TOO_LARGE'
const INVALID_CODE = 'IMAGE_GRID_INVALID'

/** Scanline family: rows carry horizontal lines, columns carry vertical lines. */
type Axis = 'row' | 'column'

/** Inclusive pixel range of one separator line. */
type LineRange = [number, number]

/** Whether the pixel at `offset` reaches the white threshold on all color channels. */
function isWhite(data: ImageData['data'], offset: number, threshold: number): boolean {
  return (data[offset] ?? 0) >= threshold
    && (data[offset + 1] ?? 0) >= threshold
    && (data[offset + 2] ?? 0) >= threshold
}

/** Whether one whole scanline is white enough to be a separator. */
function isWhiteScanline(image: ImageData, axis: Axis, index: number, threshold: number): boolean {
  const { data, width, height } = image
  const length = axis === 'row' ? width : height
  let white = 0
  for (let step = 0; step < length; step += 1) {
    const offset = axis === 'row' ? (index * width + step) * 4 : (step * width + index) * 4
    if (isWhite(data, offset, threshold)) white += 1
  }
  return white >= Math.floor(length * WHITE_LINE_COVERAGE)
}

/** Merge consecutive white scanlines into one line range. */
function mergeWhiteLines(white: readonly boolean[]): LineRange[] {
  const ranges: LineRange[] = []
  let start = -1
  for (let index = 0; index < white.length; index += 1) {
    if (white[index] === true) {
      if (start < 0) start = index
      continue
    }
    if (start >= 0) {
      ranges.push([start, index - 1])
      start = -1
    }
  }
  if (start >= 0) ranges.push([start, white.length - 1])
  return ranges
}

/** Drop border-adjacent lines and lines too wide or too narrow to be a grid separator. */
function filterGridLines(ranges: readonly LineRange[], length: number): LineRange[] {
  const inset = Math.max(1, Math.floor(length * GRID_BORDER_INSET_RATIO))
  return ranges.filter(([start, end]) => {
    const width = end - start + 1
    return width >= GRID_LINE_WIDTH_MIN
      && width <= GRID_LINE_WIDTH_MAX
      && start >= inset
      && end <= length - 1 - inset
  })
}

/** Detect separator candidates along one axis at one white threshold. */
function lineRanges(image: ImageData, axis: Axis, threshold: number): LineRange[] {
  const scanlineCount = axis === 'row' ? image.height : image.width
  const white: boolean[] = []
  for (let index = 0; index < scanlineCount; index += 1) {
    white.push(isWhiteScanline(image, axis, index, threshold))
  }
  const scanlineLength = axis === 'row' ? image.width : image.height
  return filterGridLines(mergeWhiteLines(white), scanlineLength)
}

/**
 * Pick the strictest threshold that finds the same line counts as the widest one.
 * @param image - source pixels.
 * @returns accepted line ranges per direction, or undefined when no usable grid exists.
 */
function selectGridBase(image: ImageData): { rows: LineRange[]; columns: LineRange[] } | undefined {
  const candidates = WHITE_CHANNEL_THRESHOLDS.map(threshold => ({
    rows: lineRanges(image, 'row', threshold),
    columns: lineRanges(image, 'column', threshold),
  }))
  const widest = candidates.at(-1)
  if (widest === undefined) return undefined
  const rowCount = widest.rows.length
  const columnCount = widest.columns.length
  if (rowCount < GRID_LINE_COUNT_MIN || rowCount > GRID_LINE_COUNT_MAX) return undefined
  if (columnCount < GRID_LINE_COUNT_MIN || columnCount > GRID_LINE_COUNT_MAX) return undefined
  return candidates.find(candidate => candidate.rows.length === rowCount && candidate.columns.length === columnCount)
}

/** Smallest channel value along one scanline, per pixel. */
function scanlineChannelMinima(image: ImageData, axis: Axis, index: number): number[] {
  const { data, width, height } = image
  const length = axis === 'row' ? width : height
  const minima: number[] = []
  for (let step = 0; step < length; step += 1) {
    const offset = axis === 'row' ? (index * width + step) * 4 : (step * width + index) * 4
    minima.push(Math.min(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0))
  }
  return minima
}

/** Whether a scanline is the light antialias transition next to a white line. */
function isTransitionScanline(image: ImageData, axis: Axis, index: number): boolean {
  const minima = scanlineChannelMinima(image, axis, index)
  if (minima.length === 0) return false
  const ordered = [...minima].sort((left, right) => left - right)
  const low = ordered[Math.floor((ordered.length - 1) * 0.1)] ?? 0
  const mean = minima.reduce((sum, value) => sum + value, 0) / minima.length
  return mean >= TRANSITION_MIN_MEAN && low >= TRANSITION_MIN_CHANNEL
}

/** Grow one line range by at most {@link FEATHER_MAX} transition pixels per side. */
function expandLineRange([start, end]: LineRange, image: ImageData, axis: Axis): LineRange {
  let first = start
  for (let step = 0; step < FEATHER_MAX; step += 1) {
    const candidate = first - 1
    if (candidate < 0 || !isTransitionScanline(image, axis, candidate)) break
    first = candidate
  }
  let last = end
  for (let step = 0; step < FEATHER_MAX; step += 1) {
    const candidate = last + 1
    if (candidate >= (axis === 'row' ? image.height : image.width) || !isTransitionScanline(image, axis, candidate)) break
    last = candidate
  }
  return [first, last]
}

/**
 * Detect the white separator lines of a contact sheet and expand them over their antialias pixels.
 * @param image - source pixels; rows are horizontal lines and columns are vertical lines.
 * @param messages - localized failure copy for a missing grid.
 * @returns inclusive line ranges per direction, in ascending order.
 * @throws {HarnessError} `IMAGE_GRID_NOT_FOUND` with `messages.notFound` when either direction has no 1..3 usable lines.
 */
export function detectGrid(image: ImageData, messages: GridSplitMessages): { columns: [number, number][]; rows: [number, number][] } {
  const selected = selectGridBase(image)
  if (selected === undefined) throw new HarnessError(messages.notFound, NOT_FOUND_CODE)
  return {
    columns: selected.columns.map(range => expandLineRange(range, image, 'column')),
    rows: selected.rows.map(range => expandLineRange(range, image, 'row')),
  }
}

/**
 * Cut one axis into panel bounds around its detected separator lines.
 * @param length - source side length in pixels.
 * @param lines - separator line ranges for this axis, as returned by {@link detectGrid}.
 * @param notFoundMessage - localized failure copy for a grid whose panels are too small.
 * @returns half-open panel bounds in ascending order; the lines themselves are excluded.
 * @throws {HarnessError} `IMAGE_GRID_NOT_FOUND` with `notFoundMessage` when any panel is smaller than 64 pixels.
 */
export function panelBounds(length: number, lines: readonly LineRange[], notFoundMessage: string): [number, number][] {
  const bounds: [number, number][] = []
  let start = 0
  for (const [lineStart, lineEnd] of lines) {
    if (lineStart - start < MIN_PANEL_SIZE) throw new HarnessError(notFoundMessage, NOT_FOUND_CODE)
    bounds.push([start, lineStart])
    start = lineEnd + 1
  }
  if (length - start < MIN_PANEL_SIZE) throw new HarnessError(notFoundMessage, NOT_FOUND_CODE)
  bounds.push([start, length])
  return bounds
}

/**
 * Split one rendered image into JPEG panels in reading order.
 * @param source - loaded element or canvas holding the generated image.
 * @param width - source width in pixels; the caller reads it from the loaded image.
 * @param height - source height in pixels.
 * @param messages - localized failure copy for oversized sources, unreadable pixels and missing grids.
 * @returns a promise of one JPEG data URL and file name per panel, row by row; it rejects with
 *   `IMAGE_GRID_TOO_LARGE` above 4096 pixels per side or 32M pixels, `IMAGE_GRID_INVALID` when pixels
 *   cannot be read, and `IMAGE_GRID_NOT_FOUND` when no panel grid exists.
 */
export function splitGridImage(
  source: CanvasImageSource, width: number, height: number, messages: GridSplitMessages,
): Promise<SplitTile[]> {
  return Promise.resolve().then(() => splitGridPixels(source, width, height, messages))
}

/** Canvas work behind {@link splitGridImage}; callers observe its failures as rejections there. */
function splitGridPixels(
  source: CanvasImageSource, width: number, height: number, messages: GridSplitMessages,
): SplitTile[] {
  if (width <= 0 || height <= 0) throw new HarnessError(messages.invalid, INVALID_CODE)
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new HarnessError(messages.tooLarge, TOO_LARGE_CODE)
  }
  // The side cap bounds a 4096² source at 16M pixels, below the 32M budget;
  // this guard covers a future side increase.
  /* v8 ignore next -- unreachable while the accepted side cap stays at 4096 pixels. */
  if (width * height > MAX_IMAGE_PIXELS) throw new HarnessError(messages.tooLarge, TOO_LARGE_CODE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new HarnessError(messages.invalid, INVALID_CODE)
  let pixels: ImageData
  try {
    context.drawImage(source, 0, 0, width, height)
    pixels = context.getImageData(0, 0, width, height)
  } catch (cause) {
    throw new HarnessError(messages.invalid, INVALID_CODE, { cause })
  }
  const { columns, rows } = detectGrid(pixels, messages)
  const rowBounds = panelBounds(height, rows, messages.notFound)
  const columnBounds = panelBounds(width, columns, messages.notFound)
  const tiles: SplitTile[] = []
  for (const [rowIndex, [top, bottom]] of rowBounds.entries()) {
    for (const [columnIndex, [left, right]] of columnBounds.entries()) {
      const tile = document.createElement('canvas')
      tile.width = right - left
      tile.height = bottom - top
      const tileContext = tile.getContext('2d')
      if (tileContext === null) throw new HarnessError(messages.invalid, INVALID_CODE)
      tileContext.drawImage(canvas, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top)
      tiles.push({
        dataUrl: tile.toDataURL('image/jpeg', JPEG_QUALITY),
        name: `grid-split-${rowIndex + 1}-${columnIndex + 1}.jpg`,
      })
    }
  }
  return tiles
}
