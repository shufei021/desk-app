// @vitest-environment jsdom
/** Deterministic image-parameter suggestions and their request budget. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_PARAMS, type ImageParams } from '../src/client/image-params.ts'
import {
  estimateBudget, pendingSuggestion, sameSelection, suggestParams, type ParamSuggestion,
} from '../src/client/param-suggestions.ts'

/** Selection equal to the suggestion, used to prove an already-satisfied suggestion is not shown. */
function applied(suggestion: ParamSuggestion): ImageParams {
  return {
    ...DEFAULT_IMAGE_PARAMS, ratio: suggestion.ratio, resolution: suggestion.resolution,
    quality: suggestion.quality, count: suggestion.count,
  }
}

describe('parameter suggestions', () => {
  it('reads vertical, horizontal, panoramic and square compositions from the description', () => {
    const cases: readonly { prompt: string; ratio: string; reason: string }[] = [
      { prompt: '竖版海报，人像全身立绘', ratio: '9:16', reason: 'portrait' },
      { prompt: '手机壁纸，一位女孩', ratio: '9:16', reason: 'portrait' },
      { prompt: '宽幅风景，雨后山谷', ratio: '16:9', reason: 'landscape' },
      { prompt: '电影感的城市夜景', ratio: '16:9', reason: 'landscape' },
      { prompt: '全景城市天际线 21:9', ratio: '21:9', reason: 'ultraWide' },
      { prompt: '一个头像图标', ratio: '1:1', reason: 'square' },
      { prompt: '一只橘猫', ratio: '1:1', reason: 'balanced' },
    ]
    for (const item of cases) {
      const suggestion = suggestParams(item.prompt, 0, 'none')
      expect(suggestion.ratio, item.prompt).toBe(item.ratio)
      expect(suggestion.reason, item.prompt).toBe(item.reason)
    }
  })

  it('lets a template preset override every description rule', () => {
    const turnaround = suggestParams('竖版人像，草图', 0, 'characterTurnaround')
    expect(turnaround).toEqual({ ratio: '16:9', resolution: '2K', quality: 'high', count: 1, reason: 'preset' })
    const scene = suggestParams('全景宽幅，四个方案', 0, 'sceneMultiView')
    expect(scene).toEqual({ ratio: '1:1', resolution: '2K', quality: 'high', count: 1, reason: 'preset' })
  })

  it('maps detail and draft words to quality and resolution', () => {
    expect(suggestParams('4K 高清细节的海报', 0, 'none'))
      .toMatchObject({ quality: 'high', resolution: '4K', reason: 'qualityHigh' })
    expect(suggestParams('印刷级质感', 0, 'none'))
      .toMatchObject({ quality: 'high', resolution: '4K', reason: 'qualityHigh' })
    expect(suggestParams('快速草图一张', 0, 'none'))
      .toMatchObject({ quality: 'low', resolution: '1K', reason: 'qualityLow' })
    expect(suggestParams('一只橘猫', 0, 'none'))
      .toMatchObject({ quality: 'medium', resolution: '2K' })
  })

  it('maps option and comparison words to the requested count', () => {
    expect(suggestParams('给我四个方案', 0, 'none')).toMatchObject({ count: 4, reason: 'countMany' })
    expect(suggestParams('几个变体', 0, 'none')).toMatchObject({ count: 4 })
    expect(suggestParams('两组对比', 0, 'none')).toMatchObject({ count: 2, reason: 'countCompare' })
    expect(suggestParams('一张备选', 0, 'none')).toMatchObject({ count: 2 })
    expect(suggestParams('一只橘猫', 0, 'none')).toMatchObject({ count: 1 })
  })

  it('caps a 4K target at 2K when reference images are attached', () => {
    const withoutReference = suggestParams('高清细节的海报', 0, 'none')
    expect(withoutReference.resolution).toBe('4K')
    const withReference = suggestParams('高清细节的海报', 1, 'none')
    expect(withReference).toMatchObject({ quality: 'high', resolution: '2K', reason: 'reference' })
    // A target already at or below 2K keeps its own reason.
    expect(suggestParams('竖版海报', 2, 'none')).toMatchObject({ resolution: '2K', reason: 'portrait' })
  })

  it('hides a suggestion that the current selection already satisfies', () => {
    expect(pendingSuggestion('', 0, 'none', undefined)).toBeUndefined()
    expect(pendingSuggestion('   ', 0, 'none', undefined)).toBeUndefined()

    const suggestion = suggestParams('一只橘猫', 0, 'none')
    expect(sameSelection(suggestion, applied(suggestion))).toBe(true)
    expect(pendingSuggestion('一只橘猫', 0, 'none', applied(suggestion))).toBeUndefined()

    expect(pendingSuggestion('一只橘猫', 0, 'none', DEFAULT_IMAGE_PARAMS))
      .toMatchObject({ resolution: '2K', quality: 'medium' })

    const wider = suggestParams('宽幅风景', 0, 'none')
    expect(pendingSuggestion('宽幅风景', 0, 'none', undefined)).toEqual(wider)
  })

  it('estimates one image in megapixels and the requested image count', () => {
    expect(estimateBudget(DEFAULT_IMAGE_PARAMS)).toEqual({ megapixels: 1, images: 1 })
    expect(estimateBudget({ ...DEFAULT_IMAGE_PARAMS, width: 2048, height: 1152, count: 2 }))
      .toEqual({ megapixels: 2.4, images: 2 })
    expect(estimateBudget({ ...DEFAULT_IMAGE_PARAMS, width: 3840, height: 2160, count: 4 }))
      .toEqual({ megapixels: 8.3, images: 4 })
  })
})
