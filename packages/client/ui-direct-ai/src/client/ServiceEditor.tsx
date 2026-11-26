/** Controlled, write-only credential editor with explicit public and key-scoped model discovery. */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Capability, DirectorySource, ServiceId, ServiceInput } from '@deepseek-ai/dsh-direct-ai/types'
import { validParameters, type DirectoryState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type { DirectKey } from './locales.ts'
import { ModelBrowser } from './ModelBrowser.tsx'
import { normalizedBaseURL } from './model-browser.ts'
import css from './DirectPage.module.css'

/** Unsaved form fields; the API key exists only while this editor is open. */
export interface ServiceDraft {
  name: string
  baseURL: string
  model: string
  apiKey: string
  capability: Capability
  endpoint: string
  parametersJson: string
  platform: string
  groupId: number | undefined
  groupName: string
}

/** Parent-controlled editor values and acknowledged save actions. */
interface ServiceEditorProps extends PropsLocale<'directAi'> {
  draft: ServiceDraft
  serviceId: ServiceId | undefined
  savedBaseURL: string | undefined
  saving: boolean
  saveError: boolean
  directory: DirectoryState
  onDiscover(this: void, source: DirectorySource): Promise<boolean>
  onClearDirectory(this: void): void
  onChange(this: void, draft: ServiceDraft): void
  onSave(this: void, input: ServiceInput): Promise<boolean>
  onClose(this: void): void
  onReload(this: void): Promise<void>
}

/**
 * Render a controlled service form without receiving or restoring a saved credential.
 * @param props - current drafts, directory status, localized copy and parent-owned actions.
 * @returns the modal; submitted keys are cleared before waiting for acknowledgement, not during discovery.
 */
export function ServiceEditor({
  draft, serviceId, savedBaseURL, saving, saveError, directory, onDiscover, onClearDirectory, onChange, onSave, onClose, onReload, t,
}: ServiceEditorProps): ReactNode {
  const id = useId()
  const [validation, setValidation] = useState<DirectKey>()
  const [source, setSource] = useState<'aiyoyoo-public' | 'provider'>()
  const [preset, setPreset] = useState(false)
  const base = normalizedBaseURL(draft.baseURL)
  const savedBase = savedBaseURL === undefined ? undefined : normalizedBaseURL(savedBaseURL)
  const canUseSaved = serviceId !== undefined && base !== undefined && base === savedBase
  const needsReplacementKey = serviceId !== undefined && !canUseSaved && !draft.apiKey.trim()
  const clearDirectory = (): void => { setSource(undefined); onClearDirectory() }
  const change = (patch: Partial<ServiceDraft>): void => {
    setValidation(undefined)
    if ((patch.baseURL !== undefined && patch.baseURL !== draft.baseURL)
      || (patch.apiKey !== undefined && patch.apiKey !== draft.apiKey)
      || (patch.capability !== undefined && patch.capability !== draft.capability)) clearDirectory()
    onChange({ ...draft, ...patch })
  }
  const discover = (kind: 'aiyoyoo-public' | 'provider'): void => {
    if (saving) return
    let request: DirectorySource
    if (kind === 'aiyoyoo-public') request = { kind: 'aiyoyoo-public' }
    else {
      if (base === undefined) { setValidation('invalidURL'); return }
      if (draft.apiKey.trim()) request = { kind: 'draft', baseURL: draft.baseURL.trim(), apiKey: draft.apiKey.trim() }
      else if (canUseSaved) request = { kind: 'saved', serviceId }
      else { setValidation('directoryKeyRequired'); return }
    }
    onClearDirectory()
    setValidation(undefined)
    setSource(kind)
    void onDiscover(request)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving || saveError) return
    if (!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim() || (serviceId === undefined && !draft.apiKey.trim())) {
      setValidation('required')
      return
    }
    if (base === undefined) { setValidation('invalidURL'); return }
    if (needsReplacementKey) { setValidation('directoryKeyRequired'); return }
    if (!validParameters(draft.parametersJson)) { setValidation('invalidJson'); return }
    const input: ServiceInput = {
      ...(serviceId === undefined ? {} : { id: serviceId }),
      name: draft.name.trim(), baseURL: draft.baseURL.trim(), model: draft.model.trim(), capability: draft.capability,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
      ...(draft.parametersJson.trim() ? { parametersJson: draft.parametersJson } : {}),
      ...(draft.platform.trim() ? { platform: draft.platform.trim() } : {}),
      ...(draft.groupId === undefined ? {} : { groupId: draft.groupId }),
      ...(draft.groupName.trim() ? { groupName: draft.groupName.trim() } : {}),
    }
    clearDirectory()
    onChange({ ...draft, apiKey: '' })
    void onSave(input)
  }
  const error = validation ?? (saveError ? 'saveError' : undefined)
  const visibleDirectory: DirectoryState = source === undefined || (directory.value !== undefined && directory.value.source !== source)
    ? { phase: 'idle', value: undefined } : directory
  return (
    <Modal open title={t(serviceId === undefined ? 'add' : 'edit')} closeLabel={t('close')}
      description={t('compatibility')} onClose={() => { if (!saving) onClose() }} className={clsx(css.editorModal)}
      contentClassName={clsx(css.modalContent)} footer={(
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" form={id} variant="primary" disabled={saving || saveError} aria-busy={saving}>
            {t(saving ? 'saving' : 'save')}
          </Button>
        </>
      )}>
      <form id={id} className={css.form} onSubmit={submit} noValidate autoComplete="off">
        <fieldset className={css.fieldset} disabled={saving}>
          <div className={css.presetSection}>
            <span className={css.fieldLabel}>{t('quickSetup')}</span>
            <div className={css.filters}>
              <Button variant="outline" size="sm" aria-pressed={preset} onClick={() => {
                clearDirectory(); setPreset(true)
                change({ name: t('aiyoyooPreset'), baseURL: 'https://www.aiyoyoo.com/v1', capability: 'chat', endpoint: '' })
              }}>{t('aiyoyooPreset')}</Button>
              <Button variant="outline" size="sm" aria-pressed={!preset} onClick={() => { setPreset(false) }}>{t('customPreset')}</Button>
            </div>
            {preset && <p className={css.hint}>{t('aiyoyooPresetHint')}</p>}
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-name`}>{t('name')}</label>
            <Input id={`${id}-name`} value={draft.name} onChange={(event) => { change({ name: event.target.value }) }}
              className={clsx(css.input)} required data-modal-autofocus />
          </div>
          <div className={css.field}>
            <span id={`${id}-protocol`}>{t('protocol')}</span>
            <div className={css.protocols} role="radiogroup" aria-labelledby={`${id}-protocol`}>
              {(['chat', 'image', 'video'] as const).map(capability => (
                <label className={css.protocolChoice} key={capability}>
                  <input type="radio" name={`${id}-capability`} value={capability} checked={draft.capability === capability}
                    onChange={() => { change({ capability }) }} />
                  <span>{t(`${capability}Protocol`)}</span>
                </label>
              ))}
            </div>
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-base`}>{t('baseURL')}</label>
            <Input id={`${id}-base`} type="url" value={draft.baseURL} className={clsx(css.input)} required
              aria-invalid={validation === 'invalidURL'} onChange={(event) => { setPreset(false); change({ baseURL: event.target.value }) }} />
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-key`}>{t('apiKey')}</label>
            <Input id={`${id}-key`} type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey}
              className={clsx(css.input)} required={serviceId === undefined || needsReplacementKey}
              placeholder={t(serviceId === undefined || needsReplacementKey ? 'keyRequired' : 'keyKeep')}
              aria-describedby={`${id}-key-hint`} onChange={(event) => { change({ apiKey: event.target.value }) }} />
            <p id={`${id}-key-hint`} className={needsReplacementKey ? css.warning : css.hint}>
              {t(needsReplacementKey ? 'changedURLKeyHint' : 'keyHint')}
            </p>
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-model`}>{t('model')}</label>
            <Input id={`${id}-model`} value={draft.model} className={clsx(css.input)} required
              onChange={(event) => { change({ model: event.target.value }) }} />
          </div>
          <div className={css.directoryActions}>
            <Button variant="outline" size="sm" onClick={() => { discover('aiyoyoo-public') }}>{t('publicDirectory')}</Button>
            <Button variant="outline" size="sm" onClick={() => { discover('provider') }}>{t('keyDirectory')}</Button>
          </div>
          <ModelBrowser key={source ?? 'idle'} directory={visibleDirectory} t={t} selectedModel={draft.model} selectedGroupId={draft.groupId}
            onRetry={() => { if (source !== undefined) discover(source) }}
            onSelect={(model) => { change({ model: model.id, platform: model.platform, groupId: model.groupId, groupName: model.groupName ?? '' }) }} />
          <div className={css.annotationFields}>
            <div className={css.field}>
              <label htmlFor={`${id}-platform`}>{t('platformLabel')}</label>
              <Input id={`${id}-platform`} className={clsx(css.input)} value={draft.platform}
                onChange={(event) => { change({ platform: event.target.value }) }} />
            </div>
            <div className={css.field}>
              <label htmlFor={`${id}-group`}>{t('groupLabel')}</label>
              <Input id={`${id}-group`} className={clsx(css.input)} value={draft.groupName}
                onChange={(event) => { change({ groupName: event.target.value }) }} />
            </div>
          </div>
          <p className={css.hint}>{t('localLabelsHint')}</p>
          <div className={css.field}>
            <label htmlFor={`${id}-endpoint`}>{t('endpoint')}</label>
            <textarea id={`${id}-endpoint`} className={css.textarea} rows={2} spellCheck={false} value={draft.endpoint}
              aria-describedby={`${id}-endpoint-hint`} onChange={(event) => { change({ endpoint: event.target.value }) }} />
            <p id={`${id}-endpoint-hint`} className={css.hint}>{t('endpointHint')}</p>
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-parameters`}>{t('parameters')}</label>
            <textarea id={`${id}-parameters`} className={css.jsonInput} rows={4} spellCheck={false} value={draft.parametersJson}
              aria-invalid={validation === 'invalidJson'} aria-describedby={`${id}-parameters-hint`}
              onChange={(event) => { change({ parametersJson: event.target.value }) }} />
            <p id={`${id}-parameters-hint`} className={css.hint}>{t('parametersHint')}</p>
          </div>
        </fieldset>
        <div className={css.formFeedback} aria-live="polite">
          {error !== undefined && <p className={css.error} role="alert">{t(error)}</p>}
          {saveError && <Button size="sm" variant="outline" onClick={() => { void onReload() }}>{t('retry')}</Button>}
        </div>
      </form>
    </Modal>
  )
}
