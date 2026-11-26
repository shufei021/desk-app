// @vitest-environment jsdom
/** Mask primitives: transparency detection, brush erasure, canvas encoding and file naming. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  drawMask, eraseAt, fillMask, hasTransparentPixel, maskFileFromDataUrl, maskFileName, readMask,
} from '../src/client/mask-editor.ts'

/**
 * Build one row of mask pixels with the given alpha values.
 * @param alphas - alpha of each pixel; jsdom exposes no ImageData constructor.
 * @returns synthetic ImageData with black RGB and the supplied alpha.
 */
function maskPixels(alphas: readonly number[]): ImageData {
  const data = new Uint8ClampedArray(alphas.length * 4)
  for (const [index, alpha] of alphas.entries()) data[index * 4 + 3] = alpha
  return { colorSpace: 'srgb', data, width: alphas.length, height: 1 }
}

/** Recording 2D context: jsdom has no canvas implementation. */
function recordingContext(pixels: ImageData = maskPixels([255])): {
  context: CanvasRenderingContext2D
  arc: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
  fillRect: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  getImageData: ReturnType<typeof vi.fn>
} {
  const arc = vi.fn()
  const drawImage = vi.fn()
  const fillRect = vi.fn()
  const clearRect = vi.fn()
  const getImageData = vi.fn(() => pixels)
  const context: Partial<CanvasRenderingContext2D> = {
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '#000',
    beginPath: vi.fn(),
    arc,
    fill: vi.fn(),
    fillRect,
    clearRect,
    drawImage,
    getImageData,
  }
  return { context: context as CanvasRenderingContext2D, arc, drawImage, fillRect, clearRect, getImageData }
}

/** Serve the recording context to every canvas created by the test. */
function useContext(context: CanvasRenderingContext2D): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
}

/** Create a mask canvas with an explicit size. */
function aCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

afterEach(() => { vi.restoreAllMocks() })

describe('mask transparency', () => {
  it('accepts a fully opaque mask', () => {
    expect(hasTransparentPixel(maskPixels([255, 255, 255, 255]))).toBe(false)
  })

  it('finds one erased pixel', () => {
    expect(hasTransparentPixel(maskPixels([255, 254, 255]))).toBe(true)
    expect(hasTransparentPixel(maskPixels([0]))).toBe(true)
  })

  it('treats an empty mask as having nothing erased', () => {
    expect(hasTransparentPixel(maskPixels([]))).toBe(false)
  })
})

describe('brush erasure', () => {
  it('erases a circle with destination-out', () => {
    const { context, arc } = recordingContext()
    eraseAt(context, 10, 20, 35)
    expect(context.globalCompositeOperation).toBe('destination-out')
    expect(arc).toHaveBeenCalledExactlyOnceWith(10, 20, 35, 0, Math.PI * 2)
  })

  it('restores an opaque black surface on reset', () => {
    const { context, fillRect } = recordingContext()
    fillMask(context, 200, 100)
    expect(context.globalCompositeOperation).toBe('source-over')
    expect(context.globalAlpha).toBe(1)
    expect(context.fillStyle).toBe('#000')
    expect(fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 200, 100)
  })

  it('redraws a kept mask over cleared pixels', () => {
    const { context, clearRect, drawImage } = recordingContext()
    const image = document.createElement('img')
    drawMask(context, image, 200, 100)
    expect(context.globalCompositeOperation).toBe('source-over')
    expect(context.globalAlpha).toBe(1)
    expect(clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 200, 100)
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0, 200, 100)
  })
})

describe('mask encoding', () => {
  it('returns the PNG and the pixels it erased', () => {
    const pixels = maskPixels([255, 0])
    const { context, getImageData } = recordingContext(pixels)
    useContext(context)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=')
    expect(readMask(aCanvas(2, 1))).toEqual({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', pixels })
    expect(getImageData).toHaveBeenCalledExactlyOnceWith(0, 0, 2, 1)
  })

  it('reports an unsized canvas', () => {
    expect(readMask(aCanvas(0, 0))).toBeUndefined()
  })

  it('reports a canvas without a 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(readMask(aCanvas(2, 1))).toBeUndefined()
  })

  it('reports pixels the canvas refuses to expose', () => {
    const { context } = recordingContext()
    vi.spyOn(context, 'getImageData').mockImplementation(() => { throw new Error('tainted canvas') })
    useContext(context)
    expect(readMask(aCanvas(2, 1))).toBeUndefined()
  })
})

describe('mask file', () => {
  it('decodes the PNG into an uploaded file', () => {
    const file = maskFileFromDataUrl('data:image/png;base64,iVBORw0KGgo=', 'sea-mask.png')
    expect(file).toBeInstanceOf(File)
    expect(file?.name).toBe('sea-mask.png')
    expect(file?.type).toBe('image/png')
    expect(file?.size).toBe(8)
  })

  it('rejects a data URL that is not PNG', () => {
    expect(maskFileFromDataUrl('data:image/jpeg;base64,iVBORw0KGgo=', 'sea-mask.png')).toBeUndefined()
  })

  it('rejects unreadable base64', () => {
    expect(maskFileFromDataUrl('data:image/png;base64,***', 'sea-mask.png')).toBeUndefined()
  })

  it('keeps the reference name and replaces its extension', () => {
    expect(maskFileName('sea.png')).toBe('sea-mask.png')
    expect(maskFileName('portrait')).toBe('portrait-mask.png')
    expect(maskFileName('')).toBe('mask.png')
  })
})
