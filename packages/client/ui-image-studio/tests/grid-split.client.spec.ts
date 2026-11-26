// @vitest-environment jsdom
/** Grid detection and panel bounds over synthetic pixels; jsdom has no canvas 2D implementation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { detectGrid, panelBounds, splitGridImage, type GridSplitMessages } from '../src/client/grid-split.ts'

type Rgb = readonly [number, number, number]

const CONTENT: Rgb = [40, 60, 80]
const WHITE: Rgb = [255, 255, 255]
const LIGHT: Rgb = [200, 200, 200]
/** Test-owned failure copy; the module itself ships no user-visible text. */
const messages: GridSplitMessages = { notFound: 'no grid', tooLarge: 'too large', invalid: 'invalid pixels' }

/**
 * Build one ImageData from a pixel painter; jsdom exposes no ImageData constructor.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param paint - RGB value of one pixel.
 * @returns the constructed pixels with opaque alpha.
 */
function imageData(width: number, height: number, paint: (x: number, y: number) => Rgb): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = paint(x, y)
      const offset = (y * width + x) * 4
      data[offset] = red
      data[offset + 1] = green
      data[offset + 2] = blue
      data[offset + 3] = 255
    }
  }
  return { colorSpace: 'srgb', data, width, height }
}

/** Paint a contact sheet: white pixels on any supplied line, content elsewhere. */
function sheet(
  width: number,
  height: number,
  vertical: readonly (readonly [number, number])[],
  horizontal: readonly (readonly [number, number])[],
  content: Rgb = CONTENT,
): ImageData {
  return imageData(width, height, (x, y) => {
    const onColumn = vertical.some(([start, end]) => x >= start && x <= end)
    const onRow = horizontal.some(([start, end]) => y >= start && y <= end)
    return onColumn || onRow ? WHITE : content
  })
}

/** Run one action and return the HarnessError it failed with. */
function caught(run: () => unknown): HarnessError {
  try {
    run()
  } catch (error) {
    if (error instanceof HarnessError) return error
    throw error
  }
  throw new Error('expected the splitter to fail')
}

/** Await one rejection and return the HarnessError it failed with. */
async function rejected(run: Promise<unknown>): Promise<HarnessError> {
  try {
    await run
  } catch (error) {
    if (error instanceof HarnessError) return error
    throw error
  }
  throw new Error('expected the splitter to fail')
}

afterEach(() => { vi.restoreAllMocks() })

describe('grid detection', () => {
  it('finds the two separator lines of a 2×2 sheet and the panel bounds between them', () => {
    const image = sheet(200, 200, [[99, 101]], [[99, 101]])
    const grid = detectGrid(image, messages)
    expect(grid.rows).toEqual([[99, 101]])
    expect(grid.columns).toEqual([[99, 101]])
    expect(panelBounds(200, grid.rows, messages.notFound)).toEqual([[0, 99], [102, 200]])
    expect(panelBounds(200, grid.columns, messages.notFound)).toEqual([[0, 99], [102, 200]])
  })

  it('finds all three separator lines of a 3×3 sheet in reading order', () => {
    const image = sheet(320, 320, [[79, 81], [159, 161], [239, 241]], [[79, 81], [159, 161], [239, 241]])
    const grid = detectGrid(image, messages)
    expect(grid.rows).toEqual([[79, 81], [159, 161], [239, 241]])
    expect(grid.columns).toEqual([[79, 81], [159, 161], [239, 241]])
    expect(panelBounds(320, grid.rows, messages.notFound)).toEqual([[0, 79], [82, 159], [162, 239], [242, 320]])
  })

  it('rejects an image without grid lines and reports the supplied copy', () => {
    const image = sheet(200, 200, [], [])
    const failure = caught(() => detectGrid(image, messages))
    expect(failure).toBeInstanceOf(HarnessError)
    expect(failure.code).toBe('IMAGE_GRID_NOT_FOUND')
    expect(failure.message).toBe(messages.notFound)
  })

  it('does not treat a white border frame as a grid', () => {
    const image = imageData(200, 200, (x, y) => x < 2 || y < 2 || x >= 198 || y >= 198 ? WHITE : CONTENT)
    expect(caught(() => detectGrid(image, messages)).code).toBe('IMAGE_GRID_NOT_FOUND')
  })

  it('ignores a white band wider than the accepted line width', () => {
    const image = imageData(400, 400, (x, y) => {
      if (y >= 50 && y <= 89) return WHITE
      if (y === 199 || x === 199) return WHITE
      return CONTENT
    })
    const grid = detectGrid(image, messages)
    expect(grid.rows).toEqual([[199, 199]])
    expect(grid.columns).toEqual([[199, 199]])
  })

  it('falls back to a wider white threshold for slightly gray separator lines', () => {
    const gray: Rgb = [243, 243, 243]
    const image = imageData(200, 200, (x, y) => x >= 99 && x <= 101 || y >= 99 && y <= 101 ? gray : CONTENT)
    const grid = detectGrid(image, messages)
    expect(grid.rows).toEqual([[99, 101]])
    expect(grid.columns).toEqual([[99, 101]])
  })

  it('expands a line over both antialias transition pixels of a light background', () => {
    const image = sheet(300, 300, [[150, 151]], [[150, 151]], LIGHT)
    const grid = detectGrid(image, messages)
    expect(grid.rows).toEqual([[148, 153]])
    expect(grid.columns).toEqual([[148, 153]])
  })

  it('stops the expansion at a transition pixel darker than the low percentile', () => {
    const image = imageData(300, 300, (x, y) => {
      if (y >= 150 && y <= 151) return WHITE
      if (x >= 150 && x <= 151) return WHITE
      if (y === 149) return x < 40 ? CONTENT : LIGHT
      return LIGHT
    })
    const grid = detectGrid(image, messages)
    expect(grid.rows).toEqual([[150, 153]])
    expect(grid.columns).toEqual([[148, 153]])
  })
})

describe('panel bounds', () => {
  it('rejects a leading panel smaller than 64 pixels', () => {
    const failure = caught(() => panelBounds(120, [[30, 30]], messages.notFound))
    expect(failure.code).toBe('IMAGE_GRID_NOT_FOUND')
    expect(failure.message).toBe(messages.notFound)
  })

  it('rejects a trailing panel smaller than 64 pixels', () => {
    expect(caught(() => panelBounds(120, [[90, 90]], messages.notFound)).code).toBe('IMAGE_GRID_NOT_FOUND')
  })

  it('rejects a detected grid whose first panel is too small', () => {
    const grid = detectGrid(sheet(200, 200, [[100, 100]], [[20, 20]]), messages)
    expect(caught(() => panelBounds(200, grid.rows, messages.notFound)).code).toBe('IMAGE_GRID_NOT_FOUND')
  })
})

describe('canvas split', () => {
  it('crops and encodes every panel in reading order', async () => {
    const image = sheet(200, 200, [[99, 101]], [[99, 101]])
    const draws: unknown[][] = []
    const context: Partial<CanvasRenderingContext2D> = {
      drawImage: (...args: unknown[]) => { draws.push(args) },
      getImageData: () => image,
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as CanvasRenderingContext2D)
    const encoded: unknown[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      function (this: HTMLCanvasElement, type?: string, quality?: unknown) {
        encoded.push([type, quality])
        return `data:image/jpeg;base64,${this.width}x${this.height}`
      },
    )
    const tiles = await splitGridImage(document.createElement('img'), 200, 200, messages)
    expect(tiles).toEqual([
      { dataUrl: 'data:image/jpeg;base64,99x99', name: 'grid-split-1-1.jpg' },
      { dataUrl: 'data:image/jpeg;base64,98x99', name: 'grid-split-1-2.jpg' },
      { dataUrl: 'data:image/jpeg;base64,99x98', name: 'grid-split-2-1.jpg' },
      { dataUrl: 'data:image/jpeg;base64,98x98', name: 'grid-split-2-2.jpg' },
    ])
    expect(encoded).toEqual([
      ['image/jpeg', 0.92], ['image/jpeg', 0.92], ['image/jpeg', 0.92], ['image/jpeg', 0.92],
    ])
    expect(draws[0]?.[0]).toBeInstanceOf(HTMLImageElement)
    expect(draws[0]?.slice(1)).toEqual([0, 0, 200, 200])
    expect(draws.slice(1).map(args => args.slice(1))).toEqual([
      [0, 0, 99, 99, 0, 0, 99, 99],
      [102, 0, 98, 99, 0, 0, 98, 99],
      [0, 102, 99, 98, 0, 0, 99, 98],
      [102, 102, 98, 98, 0, 0, 98, 98],
    ])
  })

  it('rejects a source larger than the accepted side length before touching the canvas', async () => {
    const failure = await rejected(splitGridImage(document.createElement('img'), 4097, 100, messages))
    expect(failure.code).toBe('IMAGE_GRID_TOO_LARGE')
    expect(failure.message).toBe(messages.tooLarge)
  })

  it('rejects an empty source size', async () => {
    const failure = await rejected(splitGridImage(document.createElement('img'), 0, 0, messages))
    expect(failure.code).toBe('IMAGE_GRID_INVALID')
  })

  it('reports an unusable canvas context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const failure = await rejected(splitGridImage(document.createElement('img'), 100, 100, messages))
    expect(failure.code).toBe('IMAGE_GRID_INVALID')
    expect(failure.message).toBe(messages.invalid)
  })

  it('reports unreadable pixels', async () => {
    const context: Partial<CanvasRenderingContext2D> = {
      drawImage: () => {},
      getImageData: () => { throw new Error('tainted canvas') },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as CanvasRenderingContext2D)
    const failure = await rejected(splitGridImage(document.createElement('img'), 100, 100, messages))
    expect(failure.code).toBe('IMAGE_GRID_INVALID')
  })

  it('reports a panel canvas without a context', async () => {
    const image = sheet(200, 200, [[99, 101]], [[99, 101]])
    const context: Partial<CanvasRenderingContext2D> = {
      drawImage: () => {},
      getImageData: () => image,
    }
    let calls = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      calls += 1
      return calls === 1 ? context as CanvasRenderingContext2D : null
    })
    const failure = await rejected(splitGridImage(document.createElement('img'), 200, 200, messages))
    expect(failure.code).toBe('IMAGE_GRID_INVALID')
  })
})
