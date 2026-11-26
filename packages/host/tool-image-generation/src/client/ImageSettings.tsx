/** Explicit image-service configuration alongside, but separate from, conversation model selection. */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ServiceInput } from '@deepseek-ai/dsh-direct-ai/types'
import type { ImageGenerationSettings, ImageSettingsState } from './state.ts'
import type { ImageGenerationKey } from './locales.ts'
import css from './ImageSettings.module.css'

/** Injected configuration source and acknowledged domain actions; no credential source is exposed. */
export interface ImageSettingsInjected {
  hooks: { state: HostObservable<ImageSettingsState>; settings: HostObservable<ConfigFormSnapshot<ImageGenerationSettings>> }
  refresh(this: void): Promise<void>
  choose(this: void, id: string): Promise<boolean>
  save(this: void, input: ServiceInput): Promise<boolean>
}
/** Framework-owned settings footer and localized action face. */
export type ImageSettingsProps = PropsRuntime<'settings.models.footer'> & PropsLocale<'imageGeneration'> & InjectFace<ImageSettingsInjected>

function validURL(value: string): boolean {
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
    return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password && !url.search && !url.hash
  } catch (_invalidURL) { return false }
}

/** @param props - authoritative form/catalog snapshots and write actions. @returns a write-only image settings section. */
export function ImageSettings({ useState: useStateSource, useSettings, refresh, choose, save, t }: ImageSettingsProps): ReactNode {
  const id = useId()
  const state = useStateSource(value => value)
  const settings = useSettings(value => value)
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [menu, setMenu] = useState(false)
  const [validation, setValidation] = useState<ImageGenerationKey>()
  const services = state.services.filter(service => service.capability === 'image' && service.configured)
  const selectedId = settings.value?.defaultServiceId ?? ''
  const selected = services.find(service => service.id === selectedId)
  const locked = state.mutation !== 'idle' || state.phase !== 'ready' || settings.status !== 'ready' || !settings.writable
  const uncertain = state.error === 'saveError' || state.error === 'partialSave' || state.error === 'defaultError'
  const changeDefault = (value: string): void => { setMenu(false); void choose(value) }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (locked || uncertain) return
    if (![name, baseURL, model, key].every(value => value.trim())) { setValidation('required'); return }
    if (!validURL(baseURL.trim())) { setValidation('invalidURL'); return }
    setValidation(undefined)
    const input: ServiceInput = { name: name.trim(), baseURL: baseURL.trim(), model: model.trim(), apiKey: key.trim(), capability: 'image' }
    setKey('')
    void save(input)
  }
  return <section className={css.section} aria-labelledby={`${id}-title`}>
    <header className={css.header}><h3 id={`${id}-title`} className={css.title}>{t('title')}</h3>
      <Button size="sm" variant="outline" disabled={state.mutation !== 'idle'} onClick={() => { void refresh() }}>{t('reload')}</Button></header>
    <p className={css.hint}>{t('description')}</p>
    <p className={css.hint}>{t('separate')}</p>
    {state.phase === 'loading' && <div className={css.skeleton} role="status" aria-label={t('loading')} />}
    {state.error !== undefined && <p className={css.error} role="alert">{t(state.error)}</p>}
    {settings.status === 'unavailable' && <p className={css.error} role="alert">{t('unavailable')}</p>}
    {settings.status === 'ready' && !settings.writable && <p className={css.hint}>{t('readonly')}</p>}
    <div className={css.field}>
      <span id={`${id}-service`}>{t('defaultService')}</span>
      <Menu open={menu} portal autoFocus onClose={() => { setMenu(false) }} listClassName={css.menu}
        anchor={<Button className={css.selector} variant="outline" disabled={locked || uncertain} aria-labelledby={`${id}-service`}
          aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(value => !value) }}>
          {selected?.name ?? (selectedId === '' ? t('off') : t('select'))}</Button>}>
        <MenuItemButton current={selectedId === ''} onSelect={() => { changeDefault('') }}>{t('off')}</MenuItemButton>
        {services.map(service => <MenuItemButton key={service.id} current={selectedId === service.id}
          onSelect={() => { changeDefault(service.id) }}>{service.name} · {service.model}</MenuItemButton>)}
      </Menu>
      {selectedId !== '' && selected === undefined && <p className={css.error} role="alert">{t('missing')}</p>}
      {services.length === 0 && state.phase === 'ready' && <p className={css.hint}>{t('empty')}</p>}
    </div>
    <form className={css.form} onSubmit={submit}>
      <h4 className={css.subtitle}>{t('add')}</h4>
      <p className={css.hint}>{t('protocol')}</p>
      <Button className={css.preset} size="sm" variant="outline" disabled={locked} onClick={() => {
        setName(t('preset')); setBaseURL('https://www.aiyoyoo.com/v1'); setModel('gpt-image-2'); setValidation(undefined)
      }}>{t('preset')}</Button>
      <p className={css.hint}>{t('presetHint')}</p>
      <div className={css.grid}>
        <div className={css.field}><label htmlFor={`${id}-name`}>{t('name')}</label>
          <Input id={`${id}-name`} value={name} disabled={locked} onChange={(event) => { setName(event.target.value) }} /></div>
        <div className={css.field}><label htmlFor={`${id}-model`}>{t('model')}</label>
          <Input id={`${id}-model`} value={model} placeholder="gpt-image-2" disabled={locked}
            onChange={(event) => { setModel(event.target.value) }} /></div>
      </div>
      <div className={css.field}><label htmlFor={`${id}-base`}>{t('baseURL')}</label>
        <Input id={`${id}-base`} value={baseURL} type="url" disabled={locked} onChange={(event) => { setBaseURL(event.target.value) }} /></div>
      <div className={css.field}><label htmlFor={`${id}-key`}>{t('key')}</label>
        <Input id={`${id}-key`} value={key} type="password" autoComplete="new-password" disabled={locked}
          aria-describedby={`${id}-key-hint`} onChange={(event) => { setKey(event.target.value) }} />
        <p id={`${id}-key-hint`} className={css.hint}>{t('keyHint')}</p></div>
      {validation !== undefined && <p className={css.error} role="alert">{t(validation)}</p>}
      <p className={css.hint}>{t('billing')}</p>
      <Button type="submit" variant="primary" className={css.submit} disabled={locked || uncertain}>
        {t(state.mutation === 'saving' ? 'saving' : 'save')}</Button>
    </form>
  </section>
}
