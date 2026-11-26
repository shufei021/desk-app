/**
 * Inline prompt assistant above the image tool row: it streams one chat
 * completion that rewrites the current description into a text-to-image
 * prompt, and adopts the answer into the composer without submitting.
 *
 * The panel owns its service choice, phase and draft; the page supplies the
 * configured chat services, the current description and the streaming call.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ServiceId, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import {
  PROMPT_ASSIST_SYSTEM, rememberPromptAssistService, rememberedPromptAssistService,
} from './prompt-assist.ts'
import type { AssistChat } from '@deepseek-ai/dsh-client-direct-ai-client'
import css from './ImageStudio.module.css'

/** Panel phase; `done` keeps the answer adoptable, `failed` keeps the error visible. */
type AssistPhase = 'idle' | 'loading' | 'done' | 'failed'

/**
 * Render the inline prompt assistant.
 * @param props.services - configured chat services, in catalog order.
 * @param props.source - current description from the composer.
 * @param props.assist - streams one completion for the chosen service.
 * @param props.onAdopt - writes the answer into the composer without submitting.
 * @param props.onClose - closes the panel and stops its stream.
 * @param props.t - localized copy supplied by the page.
 * @returns the panel with its service menu, expand control, streamed answer and actions.
 */
export function PromptAssistant({ services, source, assist, onAdopt, onClose, t }: {
  services: readonly ServiceView[]
  source: string
  assist: AssistChat
  onAdopt: (text: string) => void
  onClose: () => void
  t: PropsLocale<'imageStudio'>['t']
}): ReactNode {
  const id = useId()
  const [serviceMenuOpen, setServiceMenuOpen] = useState(false)
  const [serviceId, setServiceId] = useState<ServiceId | undefined>(() => {
    const remembered = rememberedPromptAssistService()
    return (services.find(service => service.id === remembered) ?? services[0])?.id
  })
  const [phase, setPhase] = useState<AssistPhase>('idle')
  const [draft, setDraft] = useState('')
  const [errorCode, setErrorCode] = useState<string>()
  const active = useRef<AbortController>()
  const selected = services.find(service => service.id === serviceId) ?? services[0]
  const busy = phase === 'loading'
  const expandable = selected !== undefined && source.trim() !== '' && !busy

  const stop = (): void => {
    active.current?.abort()
    active.current = undefined
    setPhase('idle')
  }
  // Closing the panel drops the stream instead of leaving it writing into unmounted state.
  const panelRef = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) return
    active.current?.abort()
    active.current = undefined
  }, [])
  const chooseService = (next: ServiceId): void => {
    setServiceMenuOpen(false)
    rememberPromptAssistService(next)
    setServiceId(next)
  }
  const expand = (): void => {
    const description = source.trim()
    if (selected === undefined || description === '' || busy) return
    active.current?.abort()
    const controller = new AbortController()
    const service = selected
    active.current = controller
    setPhase('loading')
    setDraft('')
    setErrorCode(undefined)
    void assist(service.id, PROMPT_ASSIST_SYSTEM, description, (text) => {
      if (active.current !== controller) return
      setDraft(text)
    }, controller.signal).then((outcome) => {
      if (active.current !== controller) return
      active.current = undefined
      if (outcome.status === 'cancelled') { setPhase('idle'); return }
      if (outcome.status === 'failed') {
        setPhase('failed')
        setErrorCode(outcome.errorCode)
        return
      }
      setPhase('done')
    }, (_assistFailed: unknown) => {
      if (active.current !== controller) return
      active.current = undefined
      setPhase('failed')
    })
  }

  return <div className={css.assistPanel} role="region" aria-label={t('promptAssist')} ref={panelRef}>
    <div className={css.assistHeader}>
      <h2 className={css.assistTitle}>{t('promptAssist')}</h2>
      <Button variant="outline" size="sm" onClick={onClose}>{t('close')}</Button>
    </div>
    <div className={css.assistTools}>
      <Menu open={serviceMenuOpen} portal autoFocus minWidthFromAnchor selectedId={selected?.id}
        onClose={() => { setServiceMenuOpen(false) }} listClassName={css.serviceMenu}
        anchor={<Button variant="outline" size="sm" className={css.toolButton} disabled={busy || services.length === 0}
          aria-label={`${t('promptAssistService')}: ${selected?.name ?? t('selectService')}`} aria-haspopup="menu"
          aria-expanded={serviceMenuOpen} onClick={() => { setServiceMenuOpen(value => !value) }}>
          <span className={css.selectorText}>{selected?.name ?? t('selectService')}</span>
          <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
        </Button>}>
        {services.map(service => <MenuItemButton key={service.id} current={service.id === selected?.id}
          onSelect={() => { chooseService(service.id) }}><span className={css.menuLabel}>{service.name}</span></MenuItemButton>)}
      </Menu>
      <Button variant="outline" size="sm" disabled={!expandable} onClick={expand}
        aria-describedby={source.trim() === '' ? `${id}-empty` : undefined}>{t('promptAssistExpand')}</Button>
      {busy && <Button variant="outline" size="sm" onClick={stop}>{t('promptAssistStop')}</Button>}
    </div>
    {source.trim() === '' && <p id={`${id}-empty`} className={css.hint}>{t('promptAssistEmpty')}</p>}
    {draft === ''
      ? <p className={css.hint}>{t('promptAssistHint')}</p>
      : <pre className={css.assistOutput} aria-live="polite" aria-label={t('promptAssistResult')}>{draft}</pre>}
    {phase === 'failed' && <p className={css.error} role="alert">
      {t('promptAssistFailed')}
      {errorCode !== undefined && <code className={css.errorCode}>{errorCode}</code>}
    </p>}
    <div className={css.assistActions}>
      <Button variant="primary" size="sm" disabled={busy || draft.trim() === ''}
        onClick={() => { onAdopt(draft) }}>{t('promptAssistAdopt')}</Button>
      <Button variant="outline" size="sm" disabled={!expandable} onClick={expand}>{t('promptAssistRegenerate')}</Button>
    </div>
  </div>
}
