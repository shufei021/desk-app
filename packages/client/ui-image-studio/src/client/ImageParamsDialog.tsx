/**
 * Parameter dialog for one image request: aspect ratio, resolution, quality,
 * count and exact size. Every change converges the size in place and is
 * applied immediately, so the dialog has no separate confirmation step.
 */
import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IMAGE_COUNTS, IMAGE_DIMENSION_STEP, IMAGE_MAX_DIMENSION, IMAGE_MIN_DIMENSION, IMAGE_QUALITIES, IMAGE_QUALITY_LABELS,
  IMAGE_RATIOS, IMAGE_RESOLUTIONS, editDimension, selectCount, selectQuality, selectRatio, selectResolution, setRatioLock,
  type AspectRatioId, type ImageCount, type ImageParams, type ImageQuality, type ImageResolution, type ImageSize,
} from './image-params.ts'
import css from './ImageStudio.module.css'

/**
 * Render the image parameter dialog.
 * @param props.params - current selection; every change reports a complete replacement.
 * @param props.reference - first attached reference image's pixels, used by the source-image ratio.
 * @param props.onChange - stores the changed selection.
 * @param props.onClose - closes the dialog without further changes.
 * @param props.t - localized copy supplied by the page.
 * @returns the dialog with its ratio, resolution, quality, count and size controls.
 */
export function ImageParamsDialog({ params, reference, onChange, onClose, t }: {
  params: ImageParams
  reference: ImageSize | undefined
  onChange: (params: ImageParams) => void
  onClose: () => void
  t: PropsLocale<'imageStudio'>['t']
}): ReactNode {
  const id = useId()
  // Typed text stays editable between keystrokes; the reported selection is always converged.
  const [widthText, setWidthText] = useState(String(params.width))
  const [heightText, setHeightText] = useState(String(params.height))

  const change = (next: ImageParams): void => {
    setWidthText(String(next.width))
    setHeightText(String(next.height))
    onChange(next)
  }
  const chooseRatio = (ratio: AspectRatioId): void => { change(selectRatio(params, ratio, reference)) }
  const chooseResolution = (resolution: ImageResolution): void => {
    change(selectResolution(params, resolution, reference))
  }
  const chooseQuality = (quality: ImageQuality): void => { onChange(selectQuality(params, quality)) }
  const chooseCount = (count: ImageCount): void => { onChange(selectCount(params, count)) }
  const toggleLock = (lockRatio: boolean): void => { onChange(setRatioLock(params, lockRatio)) }
  const typeEdge = (edge: 'width' | 'height', text: string): void => {
    if (edge === 'width') setWidthText(text)
    else setHeightText(text)
    const value = Number(text)
    if (text.trim() === '' || !Number.isFinite(value)) return
    const next = editDimension(params, edge, value, reference)
    // The untouched edge follows the derived size while the edited text stays as typed.
    if (edge === 'width') setHeightText(String(next.height))
    else setWidthText(String(next.width))
    onChange(next)
  }
  // Leaving a field replaces an out-of-range draft with the value the request actually uses.
  const settle = (): void => {
    setWidthText(String(params.width))
    setHeightText(String(params.height))
  }

  return <Modal open title={t('imageParamsTitle')} closeLabel={t('close')} onClose={onClose}
    className={clsx(css.paramsModal)} footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}>
    <div className={css.paramsBody}>
      <div className={css.paramsField} role="group" aria-labelledby={`${id}-ratio`}>
        <span id={`${id}-ratio`} className={css.fieldLabel}>{t('aspectRatio')}</span>
        <div className={css.paramsPills}>
          <Pill active={params.ratio === 'auto'} aria-pressed={params.ratio === 'auto'}
            onClick={() => { chooseRatio('auto') }}>{t('aspectAuto')}</Pill>
          {IMAGE_RATIOS.map(ratio => <Pill key={ratio} active={params.ratio === ratio}
            aria-pressed={params.ratio === ratio} onClick={() => { chooseRatio(ratio) }}>{ratio}</Pill>)}
        </div>
      </div>
      <div className={css.paramsField} role="group" aria-labelledby={`${id}-resolution`}>
        <span id={`${id}-resolution`} className={css.fieldLabel}>{t('resolution')}</span>
        <div className={css.paramsPills}>
          {IMAGE_RESOLUTIONS.map(resolution => <Pill key={resolution} active={params.resolution === resolution}
            aria-pressed={params.resolution === resolution}
            onClick={() => { chooseResolution(resolution) }}>{resolution}</Pill>)}
        </div>
      </div>
      <div className={css.paramsField} role="group" aria-labelledby={`${id}-quality`}>
        <span id={`${id}-quality`} className={css.fieldLabel}>{t('quality')}</span>
        <div className={css.paramsPills}>
          {IMAGE_QUALITIES.map(quality => <Pill key={quality} active={params.quality === quality}
            aria-pressed={params.quality === quality}
            onClick={() => { chooseQuality(quality) }}>{t(IMAGE_QUALITY_LABELS[quality])}</Pill>)}
        </div>
      </div>
      <div className={css.paramsField} role="group" aria-labelledby={`${id}-count`}>
        <span id={`${id}-count`} className={css.fieldLabel}>{t('imageCount')}</span>
        <div className={css.paramsPills}>
          {IMAGE_COUNTS.map(count => <Pill key={count} active={params.count === count}
            aria-pressed={params.count === count} onClick={() => { chooseCount(count) }}>{String(count)}</Pill>)}
        </div>
      </div>
      <div className={css.paramsField} role="group" aria-labelledby={`${id}-size`}>
        <span id={`${id}-size`} className={css.fieldLabel}>{t('exactSize')}</span>
        <div className={css.sizeRow}>
          <Input className={clsx(css.sizeInput)} type="number" min={IMAGE_MIN_DIMENSION} max={IMAGE_MAX_DIMENSION}
            step={IMAGE_DIMENSION_STEP} value={widthText} aria-label={t('sizeWidth')}
            onChange={(event) => { typeEdge('width', event.target.value) }} onBlur={settle} />
          <span className={css.sizeTimes} aria-hidden="true">×</span>
          <Input className={clsx(css.sizeInput)} type="number" min={IMAGE_MIN_DIMENSION} max={IMAGE_MAX_DIMENSION}
            step={IMAGE_DIMENSION_STEP} value={heightText} aria-label={t('sizeHeight')}
            onChange={(event) => { typeEdge('height', event.target.value) }} onBlur={settle} />
        </div>
      </div>
      <div className={css.lockRow}>
        <Switch checked={params.lockRatio} label={t('lockRatio')} onChange={toggleLock} />
        <span className={css.fieldLabel}>{t('lockRatio')}</span>
      </div>
      <p className={css.hint}>{t('imageParamsHint')}</p>
    </div>
  </Modal>
}
