/** Embedded, presentation-only model directory; each browser owns only its search and facets. */
import { useId, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryModel } from '@deepseek-ai/dsh-direct-ai/types'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import type { DirectoryState } from '@deepseek-ai/dsh-client-direct-ai-client'
import { groupKey, groupOptions, platformOptions, type FacetOption } from './model-browser.ts'
import css from './DirectPage.module.css'

type Translate = PropsLocale<'directAi'>['t']

/** An exact-value shared menu used by directory and saved-service filters. */
interface FacetFilterProps {
  label: string
  value: string | undefined
  options: readonly FacetOption[]
  onChange(this: void, value: string | undefined): void
  t: Translate
}

/**
 * Render a localized, keyboard-accessible facet menu with an explicit all choice.
 * @param props - current facet value and choices from the displayed data.
 * @returns a shared menu with no independent data subscription.
 */
export function FacetFilter({ label, value, options, onChange, t }: FacetFilterProps): ReactNode {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.id === value)
  const choose = (next: string | undefined): void => { onChange(next); setOpen(false) }
  return <Menu open={open} portal autoFocus onClose={() => { setOpen(false) }} listClassName={css.facetMenu}
    anchor={<Button size="sm" variant="outline" className={css.facetTrigger} aria-haspopup="menu" aria-expanded={open}
      aria-label={t('filterValue', { label, value: current?.label ?? t('all') })} onClick={() => { setOpen(value => !value) }}>
      <span className={css.menuLabel}>{t('filterValue', { label, value: current?.label ?? t('all') })}</span>
    </Button>}>
    <MenuItemButton current={value === undefined} onSelect={() => { choose(undefined) }}>{t('all')}</MenuItemButton>
    {options.map(option => <MenuItemButton key={option.id} current={value === option.id} onSelect={() => { choose(option.id) }}>
      <span className={css.facetOption}>
        <span className={css.menuLabel}>{option.label}</span>
        {option.description && <span className={css.hint}>{option.description}</span>}
      </span>
    </MenuItemButton>)}
  </Menu>
}

interface ModelBrowserProps extends PropsLocale<'directAi'> {
  directory: DirectoryState
  selectedModel: string
  selectedGroupId: number | undefined
  onSelect(this: void, model: DirectoryModel): void
  onRetry(this: void): void
}

/**
 * Render only provider-returned rows; selection changes annotations but never capability or account routing.
 * @param props - controller-owned result/status and explicit selection/retry callbacks.
 * @returns a full-width embedded directory with bounded incremental rendering.
 */
export function ModelBrowser({ directory, selectedModel, selectedGroupId, onSelect, onRetry, t }: ModelBrowserProps): ReactNode {
  const id = useId()
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState<string>()
  const [group, setGroup] = useState<string>()
  const [limit, setLimit] = useState(100)
  const value = directory.value
  const index = useMemo(() => {
    const descriptions = new Map(value?.groups.map(group => [group.id, group.description]))
    return new TextSearchIndex(value?.models ?? [], item => ({
      fuzzy: [item.id, item.platform, item.groupName, item.groupId === undefined ? undefined : String(item.groupId)],
      substring: [item.groupId === undefined ? undefined : descriptions.get(item.groupId)],
    }))
  }, [value])
  const platforms = useMemo(() => platformOptions(value?.models ?? []), [value])
  const groups = useMemo(() => groupOptions(value?.models ?? [], value?.groups), [value])
  const activePlatform = platforms.some(option => option.id === platform) ? platform : undefined
  const activeGroup = groups.some(option => option.id === group) ? group : undefined
  const visibleGroups = useMemo(() => {
    if (activePlatform === undefined) return groups
    const keys = new Set(value?.models.filter(model => model.platform === activePlatform).map(groupKey))
    return groups.filter(option => keys.has(option.id))
  }, [activePlatform, groups, value])
  const filtered = index.search(search).filter(item => (activePlatform === undefined || item.platform === activePlatform)
    && (activeGroup === undefined || groupKey(item) === activeGroup))
  const changeFilter = (change: () => void): void => { change(); setLimit(100) }
  return <section className={css.modelBrowser} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className={css.browserTitle}>{t('modelDirectory')}</h3>
    {directory.phase === 'idle' && <p className={css.hint}>{t('directoryIdle')}</p>}
    {directory.phase === 'loading' && <div className={css.skeletons} role="status" aria-label={t('directoryLoading')}>
      <div className={css.skeleton} /><div className={css.skeleton} />
    </div>}
    {directory.phase === 'error' && <div className={css.notice}>
      <p className={css.error} role="alert">{t('directoryError')}
        {directory.errorCode !== undefined && <code className={css.errorCode}>{directory.errorCode}</code>}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>{t('directoryRetry')}</Button>
    </div>}
    {directory.phase === 'ready' && value !== undefined && <>
      <p className={css.directoryNotice} role="note">{t(value.source === 'aiyoyoo-public' ? 'publicDirectoryNotice' : 'providerDirectoryNotice')}</p>
      <p className={css.hint}>{t('groupAnnotationNotice')}</p>
      <div className={css.field}>
        <label htmlFor={`${id}-search`}>{t('searchModels')}</label>
        <Input id={`${id}-search`} className={clsx(css.input)} type="search" value={search}
          onChange={(event) => { changeFilter(() => { setSearch(event.target.value) }) }} />
      </div>
      <div className={css.filters}>
        <FacetFilter label={t('platform')} value={activePlatform} options={platforms} t={t}
          onChange={(next) => { changeFilter(() => { setPlatform(next); setGroup(undefined) }) }} />
        <FacetFilter label={t('group')} value={activeGroup} options={visibleGroups} t={t}
          onChange={(next) => { changeFilter(() => { setGroup(next) }) }} />
      </div>
      <p className={css.hint} role="status">{t('modelCount', { count: String(filtered.length), total: String(value.models.length) })}</p>
      {filtered.length === 0
        ? <p className={css.hint}>{t(value.models.length === 0 ? 'directoryEmpty' : 'noMatchingModels')}</p>
        : <ul className={css.modelList} aria-label={t('modelDirectory')}>
          {filtered.slice(0, limit).map(model => <li key={JSON.stringify([model.groupId ?? null, model.id, model.platform])}>
            <Button variant="ghost" className={css.modelRow} aria-pressed={model.id === selectedModel && model.groupId === selectedGroupId}
              onClick={() => { onSelect(model) }}>
              <span className={css.modelId}>{model.id}</span>
              <span className={css.modelAnnotations}>{[model.platform, model.groupName,
                model.groupId === undefined ? undefined : String(model.groupId)].filter(Boolean).join(' · ')}</span>
            </Button>
          </li>)}
        </ul>}
      {filtered.length > limit && <Button size="sm" variant="outline" className={css.showMore}
        onClick={() => { setLimit(current => current + 100) }}>{t('showMoreModels', { count: String(filtered.length - limit) })}</Button>}
    </>}
  </section>
}
