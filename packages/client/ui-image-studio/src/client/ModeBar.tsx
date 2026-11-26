/**
 * Workspace switch between the conversation and the image studio. The owner
 * supplies the displayed mode and the selection callback; the bar holds no
 * store subscription and no layout measurement.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModeBar.module.css'

/** Workspace a mode-bar choice selects. */
export type ModeBarMode = 'chat' | 'image'

/** Owner-supplied selection plus the standard localized copy seat. */
export type ModeBarProps = PropsLocale<'imageStudio'> & {
  /** Workspace currently displayed. */
  mode: ModeBarMode
  /**
   * Request another workspace; never called with the current mode.
   * @param mode - chosen workspace.
   */
  onSelect(this: void, mode: ModeBarMode): void
}

/**
 * Render the conversation/image-studio switch.
 * @param props - selected mode, selection callback and localized labels.
 * @returns the two-segment control.
 */
export function ModeBar({ mode, onSelect, t }: ModeBarProps): ReactNode {
  const choose = (next: ModeBarMode): void => {
    if (next !== mode) onSelect(next)
  }
  return <div className={css.root}>
    <div className={css.segments} role="group" aria-label={t('modeLabel')}>
      <button type="button" className={clsx(css.segment, mode === 'chat' && css.selected)}
        aria-pressed={mode === 'chat'} onClick={() => { choose('chat') }}>{t('chat')}</button>
      <button type="button" className={clsx(css.segment, mode === 'image' && css.selected)}
        aria-pressed={mode === 'image'} onClick={() => { choose('image') }}>{t('imageStudio')}</button>
    </div>
  </div>
}
