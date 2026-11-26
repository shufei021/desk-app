// @vitest-environment jsdom
/** Image parameter derivation: sizes from ratio and resolution, convergence, request JSON and storage. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_PARAMS, IMAGE_MAX_PIXELS, IMAGE_PARAMS_KEY, constrainSize, deriveSize, editDimension,
  imageParamsJson, rememberImageParams, selectCount, selectRatio, selectResolution, setRatioLock, storedImageParams,
  type ImageParams,
} from '../src/client/image-params.ts'
// The retained-request facts parser belongs to the shared controller package that displays the result card.
import { imageParamFacts } from '@deepseek-ai/dsh-client-direct-ai-client'

beforeEach(() => { window.localStorage.clear() })

/** A complete selection for tests that only change a few fields. */
function params(overrides: Partial<ImageParams> = {}): ImageParams {
  return { ...DEFAULT_IMAGE_PARAMS, ...overrides }
}

describe('image parameter sizes', () => {
  it('derives a stepped size from the ratio and the resolution long edge', () => {
    expect(deriveSize('16:9', '2K')).toEqual({ width: 2048, height: 1152 })
    expect(deriveSize('1:1', '2K')).toEqual({ width: 2048, height: 2048 })
    expect(deriveSize('4:5', '2K')).toEqual({ width: 1632, height: 2048 })
    expect(deriveSize('21:9', '1K')).toEqual({ width: 1024, height: 432 })
  })

  it('takes the source image ratio for the auto choice and falls back to a square', () => {
    expect(deriveSize('auto', '2K', { width: 3000, height: 1000 })).toEqual({ width: 2048, height: 688 })
    expect(deriveSize('auto', '1K')).toEqual({ width: 1024, height: 1024 })
  })

  it('converges 4K to the area limit instead of exceeding it', () => {
    const wide = deriveSize('16:9', '4K')
    expect(wide).toEqual({ width: 3840, height: 2160 })
    expect(wide.width * wide.height).toBe(IMAGE_MAX_PIXELS)

    const square = deriveSize('1:1', '4K')
    expect(square).toEqual({ width: 2880, height: 2880 })
    expect(square.width * square.height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS)
  })

  it('corrects an illegal size in place: stepped edges, area limit and 3:1 ratio', () => {
    expect(constrainSize(1000, 700)).toEqual({ width: 1008, height: 704 })
    expect(constrainSize(5000, 5000)).toEqual({ width: 2880, height: 2880 })
    expect(constrainSize(3840, 100)).toEqual({ width: 288, height: 96 })
    expect(constrainSize(0, 0)).toEqual({ width: 64, height: 64 })
    const extreme = constrainSize(3840, 3840)
    expect(extreme.width).toBeLessThanOrEqual(3840)
    expect(extreme.height).toBeLessThanOrEqual(3840)
    expect(extreme.width * extreme.height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS)
    expect(Math.max(extreme.width, extreme.height) / Math.min(extreme.width, extreme.height)).toBeLessThanOrEqual(3)
  })

  it('re-derives the size when the ratio or the resolution changes', () => {
    const square = params()
    const wide = selectRatio(square, '16:9')
    expect(wide).toMatchObject({ ratio: '16:9', width: 1024, height: 576 })
    const larger = selectResolution(wide, '3K')
    expect(larger).toMatchObject({ resolution: '3K', width: 3072, height: 1728 })
    const source = selectRatio(larger, 'auto', { width: 1000, height: 2000 })
    expect(source.width / source.height).toBeCloseTo(0.5, 2)
  })

  it('derives the other edge while the ratio is locked and keeps it while unlocked', () => {
    const wide = params({ ratio: '16:9', width: 2048, height: 1152 })
    const locked = editDimension(wide, 'width', 1024)
    expect(locked).toMatchObject({ width: 1024, height: 576 })
    const unlocked = editDimension(setRatioLock(wide, false), 'height', 1000)
    expect(unlocked).toMatchObject({ width: 2048, height: 1008 })
    // An over-wide unlocked edit loses width so the 3:1 bound holds.
    const overWide = editDimension(setRatioLock(wide, false), 'width', 5000)
    expect(overWide).toMatchObject({ width: 3456, height: 1152 })
    expect(overWide.width / overWide.height).toBeLessThanOrEqual(3)
  })

  it('keeps the count and quality the user chose', () => {
    expect(selectCount(params(), 3).count).toBe(3)
  })
})

describe('image parameter request JSON', () => {
  it('serializes size, quality and count as the request parameters', () => {
    const chosen = params({ width: 2048, height: 1152, quality: 'high', count: 2 })
    expect(imageParamsJson(chosen)).toBe('{"size":"2048x1152","quality":"high","n":2}')
  })

  it('recovers the displayable facts from a retained request', () => {
    expect(imageParamFacts('{"size":"2048x1152","quality":"high","n":2}'))
      .toEqual({ size: '2048x1152', quality: 'high', count: 2 })
    expect(imageParamFacts('{"temperature":0.5}')).toBeUndefined()
    expect(imageParamFacts('{"size":2048,"quality":"ultra","n":9}')).toBeUndefined()
    expect(imageParamFacts('not json')).toBeUndefined()
    expect(imageParamFacts(undefined)).toBeUndefined()
  })
})

describe('image parameter storage', () => {
  it('round-trips the selection through browser storage', () => {
    const chosen = params({ ratio: '16:9', resolution: '2K', width: 2048, height: 1152, quality: 'high', count: 2, lockRatio: false })
    rememberImageParams(chosen)
    expect(JSON.parse(window.localStorage.getItem(IMAGE_PARAMS_KEY) ?? '{}')).toMatchObject({ width: 2048, height: 1152 })
    expect(storedImageParams()).toEqual(chosen)
  })

  it('ignores unreadable or partial storage and converges stored edges', () => {
    expect(storedImageParams()).toBeUndefined()
    window.localStorage.setItem(IMAGE_PARAMS_KEY, 'not json')
    expect(storedImageParams()).toBeUndefined()
    window.localStorage.setItem(IMAGE_PARAMS_KEY, '{"width":5000,"height":5000}')
    expect(storedImageParams()).toMatchObject({
      ratio: DEFAULT_IMAGE_PARAMS.ratio, resolution: DEFAULT_IMAGE_PARAMS.resolution,
      quality: DEFAULT_IMAGE_PARAMS.quality, count: DEFAULT_IMAGE_PARAMS.count,
      width: 2880, height: 2880, lockRatio: DEFAULT_IMAGE_PARAMS.lockRatio,
    })
  })
})
