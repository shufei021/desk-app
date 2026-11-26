/** Global direct-provider UI; configuration, history and request state belong to its injected controller. */
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, Input, LinkIconMedium, Menu, MenuItemButton, Modal, SegmentedControl, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Capability, DirectFrame, DirectMessage, RunRecord, ServiceId, ServiceInput, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import {
  validParameters, type DirectPageInjected, type InteractionState,
} from '@deepseek-ai/dsh-client-direct-ai-client'
import { ServiceEditor, type ServiceDraft } from './ServiceEditor.tsx'
import { FacetFilter } from './ModelBrowser.tsx'
import { groupKey, groupOptions, platformOptions, serviceAnnotations } from './model-browser.ts'
import css from './DirectPage.module.css'

/** Main-slot props assembled from runtime seats, typed locale and controller injection. */
export type DirectPageProps = PropsRuntime<'main'> & InjectFace<DirectPageInjected> & PropsLocale<'directAi'>

type Translate = DirectPageProps['t']
interface RequestDraft { prompt: string; system: string; parametersJson: string }
interface EditorState { id: ServiceId | undefined; savedBaseURL: string | undefined; draft: ServiceDraft }

function emptyDraft(): RequestDraft { return { prompt: '', system: '', parametersJson: '' } }

function serviceDraft(service?: ServiceView): ServiceDraft {
  return {
    name: service?.name ?? '', baseURL: service?.baseURL ?? '', model: service?.model ?? '', apiKey: '',
    capability: service?.capability ?? 'chat', endpoint: service?.endpoint ?? '', parametersJson: service?.parametersJson ?? '',
    platform: service?.platform ?? '', groupId: service?.groupId, groupName: service?.groupName ?? '',
  }
}

function statusText(phase: InteractionState['phase'] | RunRecord['status'], t: Translate): string {
  return phase === 'idle' ? '' : t(phase === 'running' ? 'running' : phase)
}

function transcript(messages: readonly DirectMessage[], t: Translate): string {
  return messages.map(message => `${t(message.role === 'system' ? 'system' : message.role === 'user' ? 'user' : 'assistant')}\n${message.content}`).join('\n\n')
}

function MediaResult({ frame, t }: { frame: Extract<DirectFrame, { type: 'media' }>; t: Translate }): ReactNode {
  const [failed, setFailed] = useState(false)
  const downloadURL = new URL(frame.url, document.baseURI)
  downloadURL.searchParams.set('download', '1')
  return (
    <figure className={css.mediaResult}>
      {failed
        ? <p className={css.error} role="alert">{t('failed')}</p>
        : frame.mime.startsWith('video/')
          ? <video className={css.media} src={frame.url} controls preload="metadata" aria-label={t('result')}
            onError={() => { setFailed(true) }} />
          : <img className={css.media} src={frame.url} alt={t('result')} loading="lazy" onError={() => { setFailed(true) }} />}
      <figcaption>
        <a className={css.download} href={downloadURL.href} target="_blank" rel="noopener noreferrer" download>
          <LinkIconMedium kind="url" href={frame.url} size={14} aria-hidden="true" />{t('download')}
        </a>
      </figcaption>
    </figure>
  )
}

function RequestResults({ interaction, t }: { interaction: InteractionState; t: Translate }): ReactNode {
  const text = interaction.frames.filter(frame => frame.type === 'text').map(frame => frame.text).join('')
  const progress = interaction.frames.filter(frame => frame.type === 'progress').at(-1)
  const media = interaction.frames.filter(frame => frame.type === 'media')
  const active = interaction.phase === 'running'
  const visible = interaction.messages.length > 0 || interaction.frames.length > 0 || interaction.phase !== 'idle'
  if (!visible) return null
  return (
    <section className={css.results} aria-label={t('result')}>
      {interaction.messages.length > 0 && <pre className={css.transcript}>{transcript(interaction.messages, t)}</pre>}
      {text !== '' && <article className={css.assistant} aria-label={t('assistant')}>
        <h3 className={css.messageLabel}>{t('assistant')}</h3>
        <pre className={css.output}>{text}</pre>
      </article>}
      {media.map(frame => <MediaResult key={frame.url} frame={frame} t={t} />)}
      <div className={css.requestStatus} role="status" aria-live="polite">
        {interaction.phase !== 'idle' && <p className={css.statusLine}>
          <StateDot state={active ? 'ongoing' : interaction.phase === 'failed' ? 'error' : interaction.phase === 'completed' ? 'done' : 'idle'} />
          <span>{statusText(interaction.phase, t)}</span>
        </p>}
        {progress !== undefined && <div className={css.progress}>
          <span className={css.providerText}>{progress.status}</span>
          {progress.progress !== undefined && <progress max={100} value={progress.progress} aria-label={t('running')} />}
        </div>}
      </div>
      {(interaction.error !== undefined || interaction.phase === 'failed') && <p role="alert" className={css.error}>
        {t(interaction.error ?? 'requestError')}
        {interaction.errorCode !== undefined && <code className={css.errorCode}>{interaction.errorCode}</code>}
      </p>}
    </section>
  )
}

/**
 * Render configured capabilities and direct interaction without consulting Agent, Session or workspace state.
 * @param props - framework-bound catalog, interaction and history hooks plus narrow controller actions.
 * @returns the page, write-only service modal and acknowledged deletion confirmation.
 */
export function DirectPage({
  useCatalog, useInteraction, useHistory, useDirectory, discoverModels, clearDirectory,
  refresh, save, remove, select, submit, stop, clear, restore, backToAgent, t,
}: DirectPageProps): ReactNode {
  const catalog = useCatalog(value => value)
  const interaction = useInteraction(value => value)
  const history = useHistory(value => value)
  const directory = useDirectory(value => value)
  const id = useId()
  const [editor, setEditor] = useState<EditorState>()
  const [deleting, setDeleting] = useState<ServiceView>()
  const [serviceMenuOpen, setServiceMenuOpen] = useState(false)
  const [drafts, setDrafts] = useState<Partial<Record<ServiceId, RequestDraft>>>({})
  const [parametersError, setParametersError] = useState(false)
  const [serviceSearch, setServiceSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string>()
  const [groupFilter, setGroupFilter] = useState<string>()
  const serviceIndex = useMemo(() => new TextSearchIndex(catalog.services, item => ({
    fuzzy: [item.name, item.model, item.platform, item.groupName, t(item.capability), t(item.configured ? 'ready' : 'missingKey'),
      item.groupId === undefined ? undefined : String(item.groupId)],
    substring: [item.id, item.baseURL, item.endpoint],
  })), [catalog.services, t])
  const platforms = useMemo(() => platformOptions(catalog.services), [catalog.services])
  const groups = useMemo(() => groupOptions(catalog.services.map(serviceAnnotations)), [catalog.services])
  const activePlatform = platforms.some(option => option.id === platformFilter) ? platformFilter : undefined
  const activeGroup = groups.some(option => option.id === groupFilter) ? groupFilter : undefined
  const visibleServices = serviceIndex.search(serviceSearch).filter(item =>
    (activePlatform === undefined || item.platform === activePlatform)
    && (activeGroup === undefined || groupKey(serviceAnnotations(item)) === activeGroup))
  const configured = catalog.services.filter(service => service.configured)
  const capabilities = (['chat', 'image', 'video'] as const).filter(capability => configured.some(service => service.capability === capability))
  const service = catalog.services.find(item => item.id === interaction.serviceId)
  const capability = configured.find(item => item.id === interaction.serviceId)?.capability ?? capabilities[0]
  const services = configured.filter(item => item.capability === capability)
  const draft = interaction.serviceId === undefined ? emptyDraft() : drafts[interaction.serviceId] ?? emptyDraft()
  const running = interaction.phase === 'running'
  const mutating = catalog.mutation !== 'idle'
  const locked = running || mutating
  const usable = service?.configured === true && catalog.phase === 'ready'
  const selectedLabel = service?.configured === true ? service.name : t('selectService')

  const changeDraft = (patch: Partial<RequestDraft>): void => {
    const serviceId = interaction.serviceId
    if (serviceId === undefined) return
    setParametersError(false)
    setDrafts(current => ({ ...current, [serviceId]: { ...draft, ...patch } }))
  }
  const selectService = (serviceId: ServiceId): void => {
    if (locked) return
    setParametersError(false)
    setServiceMenuOpen(false)
    select(serviceId)
  }
  const selectCapability = (next: Capability): void => {
    const first = configured.find(item => item.capability === next)
    if (first !== undefined) selectService(first.id)
  }
  const submitRequest = (event: FormEvent): void => {
    event.preventDefault()
    if (!usable || locked || !draft.prompt.trim()) return
    if (!validParameters(draft.parametersJson)) { setParametersError(true); return }
    const serviceId = interaction.serviceId
    if (serviceId === undefined) return
    const submitted = draft
    void submit(submitted.prompt, capability === 'chat' ? submitted.system : '', submitted.parametersJson).then((completed) => {
      if (completed) setDrafts((current) => {
        const latest = current[serviceId]
        return latest?.prompt === submitted.prompt ? { ...current, [serviceId]: { ...latest, prompt: '' } } : current
      })
    })
  }
  const openEditor = (item?: ServiceView): void => {
    if (locked) return
    clearDirectory()
    setEditor({ id: item?.id, savedBaseURL: item?.baseURL, draft: serviceDraft(item) })
  }
  const closeEditor = (): void => { clearDirectory(); setEditor(undefined) }
  const saveService = async (input: ServiceInput): Promise<boolean> => {
    const confirmed = await save(input)
    if (confirmed) closeEditor()
    return confirmed
  }
  const deleteService = async (): Promise<void> => {
    if (deleting === undefined || locked || catalog.error === 'removeError') return
    if (await remove(deleting.id)) setDeleting(undefined)
  }
  const restoreRun = (run: RunRecord): void => {
    if (locked) return
    setParametersError(false)
    setDrafts(current => ({ ...current, [run.service.id]: {
      prompt: '', system: run.request.messages.find(message => message.role === 'system')?.content ?? '',
      parametersJson: run.request.parametersJson ?? '',
    } }))
    restore(run)
  }

  return (
    <div className={css.page}>
      <div className={css.pageBody}>
        <header className={css.pageHeader}>
          <div className={css.heading}>
            <h1 className={css.title}>{t('title')}</h1>
            <p className={css.description}>{t('description')}</p>
          </div>
          <Button variant="outline" onClick={backToAgent}>{t('agent')}</Button>
        </header>

        <section className={css.section} aria-labelledby={`${id}-services`}>
          <div className={css.sectionHeader}>
            <h2 id={`${id}-services`} className={css.sectionTitle}>{t('services')}</h2>
            <Button variant="outline" size="sm" disabled={locked || catalog.phase !== 'ready'} onClick={() => { openEditor() }}>{t('add')}</Button>
          </div>
          {catalog.phase === 'loading' && <div className={css.skeletons} role="status" aria-label={t('loading')}>
            <div className={css.skeleton} /><div className={css.skeleton} />
          </div>}
          {(catalog.error !== undefined || catalog.phase === 'error') && <div className={css.notice}>
            <p className={css.error} role="alert">{t(catalog.error ?? 'loadError')}</p>
            <Button variant="outline" size="sm" disabled={mutating} onClick={() => { void refresh() }}>{t('retry')}</Button>
          </div>}
          {catalog.phase === 'ready' && catalog.services.length === 0 && <div className={css.emptyState}>
            <p className={css.emptyTitle}>{t('noServices')}</p>
            <p className={css.hint}>{t('setup')}</p>
          </div>}
          {catalog.services.length > 0 && <>
            <div className={css.serviceFilters}>
              <div className={css.field}>
                <label htmlFor={`${id}-service-search`}>{t('searchServices')}</label>
                <Input id={`${id}-service-search`} type="search" className={clsx(css.input)} value={serviceSearch}
                  onChange={(event) => { setServiceSearch(event.target.value) }} />
              </div>
              <div className={css.filters}>
                <FacetFilter label={t('platform')} options={platforms} value={activePlatform} t={t}
                  onChange={(next) => { setPlatformFilter(next); setGroupFilter(undefined) }} />
                <FacetFilter label={t('group')} options={groups} value={activeGroup} t={t} onChange={setGroupFilter} />
              </div>
              <p className={css.hint} role="status">{t('serviceCount', { count: String(visibleServices.length), total: String(catalog.services.length) })}</p>
            </div>
            {visibleServices.length === 0 && <p className={css.hint}>{t('noMatchingServices')}</p>}
            <ul className={css.serviceList}>
              {visibleServices.map(item => <li className={css.serviceCard} key={item.id}>
                <div className={css.serviceInfo}>
                  <div className={css.serviceTitle}>
                    <h3 className={css.serviceName}>{item.name}</h3>
                    <span className={css.serviceState} data-configured={item.configured}>{t(item.configured ? 'ready' : 'missingKey')}</span>
                  </div>
                  <p className={css.serviceMeta}>{t(item.capability)}<span aria-hidden="true"> · </span>{item.model}</p>
                  {(item.platform || item.groupName || item.groupId !== undefined) && <p className={css.serviceMeta}>
                    {[item.platform, item.groupName, item.groupId === undefined ? undefined : String(item.groupId)].filter(Boolean).join(' · ')}
                  </p>}
                  <p className={css.endpoint}>{item.baseURL}</p>
                  {item.endpoint !== undefined && <p className={css.endpoint}>{item.endpoint}</p>}
                </div>
                <div className={css.actions}>
                  <Button variant="outline" size="sm" disabled={locked || catalog.phase !== 'ready'}
                    aria-label={`${t('edit')} ${item.name}`} onClick={() => { openEditor(item) }}>{t('edit')}</Button>
                  <Button variant="ghost" size="sm" className={css.dangerButton} disabled={locked || catalog.phase !== 'ready'}
                    aria-label={`${t('remove')} ${item.name}`} onClick={() => { setDeleting(item) }}>{t('remove')}</Button>
                </div>
              </li>)}
            </ul>
          </>}
        </section>

        <section className={css.section} aria-label={t('capabilityLabel')}>
          {capability !== undefined && capabilities.length > 0 ? <>
            <SegmentedControl id={`${id}-capabilities`} value={capability} label={t('capabilityLabel')} disabled={locked}
              options={capabilities.map(value => ({ value, label: t(value) }))} onChange={selectCapability} className={css.tabs} />
            <div id={`${id}-capabilities-${capability}-panel`} role="tabpanel" aria-labelledby={`${id}-capabilities-${capability}`}
              className={css.interactionPanel}>
              <div className={css.interactionToolbar}>
                <div className={css.selectorField}>
                  <span id={`${id}-selector`} className={css.fieldLabel}>{t('selectService')}</span>
                  <Menu open={serviceMenuOpen} portal autoFocus minWidthFromAnchor selectedId={service?.id}
                    onClose={() => { setServiceMenuOpen(false) }} listClassName={css.serviceMenu}
                    anchor={<Button variant="outline" className={css.serviceSelector} disabled={locked || catalog.phase !== 'ready'}
                      aria-labelledby={`${id}-selector ${id}-selected-service`} aria-haspopup="menu" aria-expanded={serviceMenuOpen}
                      onClick={() => { setServiceMenuOpen(value => !value) }}>
                      <span id={`${id}-selected-service`} className={css.selectorText}>{selectedLabel}</span>
                      <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
                    </Button>}>
                    {services.map(item => <MenuItemButton key={item.id} current={item.id === interaction.serviceId}
                      onSelect={() => { selectService(item.id) }}><span className={css.menuLabel}>{item.name}</span></MenuItemButton>)}
                  </Menu>
                </div>
                <Button variant="outline" size="sm" disabled={locked} onClick={() => {
                  clear(); setParametersError(false)
                  const serviceId = interaction.serviceId
                  if (serviceId !== undefined) setDrafts(current => ({ ...current, [serviceId]: emptyDraft() }))
                }}>{t('newChat')}</Button>
              </div>
              <RequestResults interaction={interaction} t={t} />
              <form className={css.composer} onSubmit={submitRequest}>
                <label className={css.fieldLabel} htmlFor={`${id}-prompt`}>{t('prompt')}</label>
                <textarea id={`${id}-prompt`} className={css.prompt} rows={4} value={draft.prompt} placeholder={t('promptHint')}
                  disabled={locked || !usable} onChange={(event) => { changeDraft({ prompt: event.target.value }) }} />
                <details className={css.advanced}>
                  <summary className={css.summary}>{t('advanced')}</summary>
                  <div className={css.advancedFields}>
                    {capability === 'chat' && <div className={css.field}>
                      <label htmlFor={`${id}-system`}>{t('system')}</label>
                      <textarea id={`${id}-system`} className={css.textarea} rows={3} value={draft.system} disabled={locked || !usable}
                        aria-describedby={`${id}-system-hint`} onChange={(event) => { changeDraft({ system: event.target.value }) }} />
                      <p id={`${id}-system-hint`} className={css.hint}>{t('systemHint')}</p>
                    </div>}
                    <div className={css.field}>
                      <label htmlFor={`${id}-extra`}>{t('parameters')}</label>
                      <textarea id={`${id}-extra`} className={css.jsonInput} rows={3} spellCheck={false} value={draft.parametersJson}
                        disabled={locked || !usable} aria-invalid={parametersError} aria-describedby={`${id}-extra-hint`}
                        onChange={(event) => { changeDraft({ parametersJson: event.target.value }) }} />
                      <p id={`${id}-extra-hint`} className={css.hint}>{t('parametersHint')}</p>
                    </div>
                  </div>
                </details>
                {parametersError && <p className={css.error} role="alert">{t('invalidJson')}</p>}
                <div className={css.composerFooter}>
                  <p className={css.hint}>{t('directNotice')}</p>
                  {running
                    ? <Button variant="outline" onClick={stop}>{t('stop')}</Button>
                    : <Button type="submit" variant="primary" disabled={!usable || locked || !draft.prompt.trim()}>{t(capability === 'chat' ? 'send' : 'generate')}</Button>}
                </div>
              </form>
            </div>
          </> : <>
            {catalog.phase !== 'loading' && <p className={css.hint}>{t('noCapability')}</p>}
            <RequestResults interaction={interaction} t={t} />
            {running && <Button variant="outline" onClick={stop}>{t('stop')}</Button>}
          </>}
          {(running || interaction.phase === 'cancelled' || capability === 'video') && <p className={css.warning}>{t('videoNotice')}</p>}
        </section>

        <details className={css.history}>
          <summary className={css.summary}>{t('history')}</summary>
          <div className={css.historyBody}>
            <p className={css.hint}>{t('historyNote')}</p>
            {history.phase === 'loading' && <div className={css.skeleton} role="status" aria-label={t('loading')} />}
            {history.phase === 'error' && <div className={css.notice}>
              <p className={css.error} role="alert">{t('historyError')}</p>
              <Button variant="outline" size="sm" disabled={mutating} onClick={() => { void refresh() }}>{t('retry')}</Button>
            </div>}
            {history.phase === 'ready' && history.records.length === 0 && <p className={css.hint}>{t('historyEmpty')}</p>}
            {history.records.length > 0 && <ul className={css.historyList}>
              {history.records.map(run => <li className={css.historyRow} key={run.id}>
                <div className={css.historyInfo}>
                  <p className={css.historyName}>{run.service.name}</p>
                  <p className={css.serviceMeta}>{t(run.service.capability)}<span aria-hidden="true"> · </span>{run.service.model}</p>
                  <time className={css.hint} dateTime={new Date(run.startedAt).toISOString()}>
                    {new Date(run.startedAt).toLocaleString()}
                  </time>
                  <p className={css.hint}>{statusText(run.status, t)}</p>
                </div>
                <Button variant="outline" size="sm" disabled={locked} aria-label={`${t('restore')} ${run.service.name}`}
                  onClick={() => { restoreRun(run) }}>{t('restore')}</Button>
              </li>)}
            </ul>}
          </div>
        </details>
      </div>
      {editor !== undefined && <ServiceEditor t={t} serviceId={editor.id} savedBaseURL={editor.savedBaseURL} draft={editor.draft}
        saving={catalog.mutation === 'saving'} directory={directory} onDiscover={discoverModels} onClearDirectory={clearDirectory}
        saveError={catalog.error === 'saveError'} onChange={(next) => { setEditor(current => current === undefined ? undefined : { ...current, draft: next }) }}
        onSave={saveService} onClose={closeEditor} onReload={refresh} />}
      <Modal open={deleting !== undefined} title={t('deleteTitle')} closeLabel={t('close')} description={t('deleteDescription')}
        className={clsx(css.deleteModal)} contentClassName={clsx(css.modalContent)}
        onClose={() => { if (!mutating) setDeleting(undefined) }}
        footer={<>
          <Button variant="outline" disabled={mutating} onClick={() => { setDeleting(undefined) }}>{t('cancel')}</Button>
          <Button variant="outline" className={css.dangerButton} disabled={locked || catalog.error === 'removeError'}
            aria-busy={catalog.mutation === 'removing'} onClick={() => { void deleteService() }}>{t('remove')}</Button>
        </>}>
        {deleting !== undefined && <p className={css.deleteName}>{deleting.name}</p>}
        {catalog.error === 'removeError' && <div className={css.notice}>
          <p className={css.error} role="alert">{t('removeError')}</p>
          <Button variant="outline" size="sm" disabled={mutating} onClick={() => { void refresh() }}>{t('retry')}</Button>
        </div>}
      </Modal>
    </div>
  )
}
