/**
 * Dedicated image-generation workspace over the existing Direct AI Remote
 * calls: the catalog supplies configured image services, history supplies
 * retained image runs, and the injected controller streams one run at a time.
 * No chat model, tool call, or Agent session participates.
 */
import { useCallback, useId, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular, ImageLightbox, Input,
  LinkIconMedium, Menu, MenuItemButton, Modal, Pill, SegmentedControl, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectFrame, ImageReference, RunRecord, ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import {
  assetFileFromUrl, readAssetUpload, type AssetCategory, type AssetLibrary, type WorkspaceAsset, type WorkspaceSummary,
} from './assets.ts'
import { splitGridImage, type SplitTile } from './grid-split.ts'
import { ImageParamsDialog } from './ImageParamsDialog.tsx'
import {
  DEFAULT_IMAGE_PARAMS, deriveSize, IMAGE_QUALITY_LABELS, imageParamsJson, rememberImageParams, storedImageParams,
  type ImageParams,
} from './image-params.ts'
import type { ImageStudioKey } from './locales.ts'
import {
  drawMask, eraseAt, fillMask, hasTransparentPixel, maskFileFromDataUrl, maskFileName, MASK_BRUSH_DEFAULT, MASK_BRUSH_MAX,
  MASK_BRUSH_MIN, readMask, type MaskEditorMessages,
} from './mask-editor.ts'
import { ModeBar } from './ModeBar.tsx'
import { pendingSuggestion, SUGGESTION_REASON_KEYS, type ParamSuggestion } from './param-suggestions.ts'
import { chatServices } from './prompt-assist.ts'
import { PromptAssistant } from './PromptAssistant.tsx'
import { composePrompt, PROMPT_PRESETS, type PromptPresetId } from './prompt-presets.ts'
import type { AssistChat, DirectPageInjected, InteractionState, ShownRun } from '@deepseek-ai/dsh-client-direct-ai-client'
import { VARIANT_STYLES, VARIANT_STYLE_LABELS, variantPrompt, type VariantStyleId } from './variant-styles.ts'
import { runVariants, type VariantOutcome, type VariantRun } from './variants.ts'
import css from './ImageStudio.module.css'

/** Face additions used only by the image workspace; the Direct page shares the base face. */
export interface ImageStudioInjected extends DirectPageInjected {
  /**
   * Image asset library over the asset folders of the registered workspaces.
   * Its bytes stay on the Host disk until one asset is attached as a reference image.
   */
  assetLibrary: AssetLibrary
  /** Stream one prompt-assistant completion without entering the workspace's displayed run. */
  assistChat: AssistChat
  /** Open one variant stream without entering the workspace's displayed run. */
  variantRun: VariantRun
}

/** Main-slot props assembled from runtime seats, typed locale and the reused controller face. */
export type ImageStudioProps = PropsRuntime<'main'> & InjectFace<ImageStudioInjected> & PropsLocale<'imageStudio'>

type Translate = ImageStudioProps['t']
type MediaFrame = Extract<DirectFrame, { type: 'media' }>

/** Host reference-upload limit for one image request. */
const MAX_REFERENCES = 8

/** Longest description the Host retains beside a run, and the counter's limit. */
const PROMPT_LIMIT = 4000

/** Composer generation mode: the free description, a template preset, or single-reference mask editing. */
type ImageModeId = PromptPresetId | 'mask'

/** Generation-mode choices in menu order; `free` submits the description alone. */
const IMAGE_MODES: readonly { id: ImageModeId; labelKey: ImageStudioKey }[] = [
  { id: 'none', labelKey: 'presetNone' },
  { id: 'characterTurnaround', labelKey: 'presetCharacterTurnaround' },
  { id: 'sceneMultiView', labelKey: 'presetSceneMultiView' },
  { id: 'mask', labelKey: 'presetMaskEdit' },
]

/** Longest first line the recent-generation list shows as its title. */
const RECENT_TITLE_LIMIT = 60

/** Longest prompt excerpt shown when a retained run has no display prompt. */
const FALLBACK_PROMPT_LIMIT = 280

/** Prompt length above which the collapsed two-line block offers an expand control. */
const PROMPT_EXPAND_LENGTH = 120

/** One uploaded reference with the local preview URL the composer shows until it is sent or removed. */
interface SelectedReference {
  readonly ref: ImageReference
  readonly preview: string
}

/** One retained mask, bound to the reference preview it was erased from. */
interface AppliedMask {
  /** Local preview URL of the single reference this mask describes. */
  readonly reference: string
  /** PNG data URL kept so a later edit starts from the erased pixels. */
  readonly dataUrl: string
  /** Durable attachment submitted as the request's `mask`. */
  readonly ref: ImageReference
}

/**
 * Keep only image media frames; text and progress frames never reach the result area.
 * @param frames - frames retained for the displayed run.
 * @returns the image frames in provider order.
 */
function imageFrames(frames: readonly DirectFrame[]): MediaFrame[] {
  return frames.filter((frame): frame is MediaFrame => frame.type === 'media' && frame.mime.startsWith('image/'))
}

/**
 * Resolve the download form of a same-origin media URL.
 * @param url - provider media URL served by the Host.
 * @returns the absolute URL that asks the Host for an attachment response.
 */
function downloadHref(url: string): string {
  const href = new URL(url, document.baseURI)
  href.searchParams.set('download', '1')
  return href.href
}

/**
 * Read the prompt paired with the displayed run: the Host-retained description, else the request's last user message.
 * @param interaction - shown run facts and the messages submitted for it.
 * @returns prompt text for the result card, shortened when only the request message remains; undefined when empty.
 */
function pairedPrompt(interaction: InteractionState): string | undefined {
  const retained = interaction.run?.displayPrompt?.trim()
  if (retained !== undefined && retained !== '') return retained
  const message = interaction.messages.filter(item => item.role === 'user').at(-1)?.content.trim()
  if (message === undefined || message === '') return undefined
  return message.length > FALLBACK_PROMPT_LIMIT ? `${message.slice(0, FALLBACK_PROMPT_LIMIT)}…` : message
}

/**
 * Reduce prompt text to one line for a compact history title.
 * @param text - prompt text, or the model name used when no prompt was retained.
 * @returns the first non-empty line, at most `RECENT_TITLE_LIMIT` characters.
 */
function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length > RECENT_TITLE_LIMIT ? `${line.slice(0, RECENT_TITLE_LIMIT)}…` : line
}

/**
 * Merge one suggestion into the current selection and derive its exact size.
 * @param current - current selection, or the provider defaults when none is stored.
 * @param suggestion - ratio, resolution, quality and count to apply.
 * @returns the complete selection the composer stores, submits and remembers.
 */
function withSuggestion(current: ImageParams, suggestion: ParamSuggestion): ImageParams {
  return {
    ...current, ratio: suggestion.ratio, resolution: suggestion.resolution,
    quality: suggestion.quality, count: suggestion.count,
    ...deriveSize(suggestion.ratio, suggestion.resolution),
  }
}

/**
 * Erase editable regions of exactly one reference image over an opaque mask.
 * The canvas keeps the reference image's natural size, so the uploaded mask matches it.
 * @param props.source - the single attached reference and its local preview URL.
 * @param props.initialMask - PNG kept from an earlier edit, restored before further erasing.
 * @param props.messages - localized copy supplied by the page.
 * @param props.onApply - stores the encoded mask; false keeps the editor open with `messages.saveFailed`.
 * @param props.onClose - closes the dialog after a stored mask, or on cancellation.
 * @returns the mask dialog with its brush controls.
 */
function MaskEditor({ source, initialMask, messages, onApply, onClose }: {
  source: SelectedReference
  initialMask: string | undefined
  messages: MaskEditorMessages
  onApply: (dataUrl: string) => Promise<boolean>
  onClose: () => void
}): ReactNode {
  const id = useId()
  const canvas = useRef<HTMLCanvasElement>(null)
  const painting = useRef(false)
  const [radius, setRadius] = useState(MASK_BRUSH_DEFAULT)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const prepare = (image: HTMLImageElement): void => {
    const element = canvas.current
    if (element === null) return
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (width === 0 || height === 0) {
      setError(messages.loadFailed)
      return
    }
    element.width = width
    element.height = height
    const context = element.getContext('2d')
    if (context === null) {
      setError(messages.loadFailed)
      return
    }
    fillMask(context, width, height)
    setError(undefined)
    setReady(true)
  }
  const restore = (image: HTMLImageElement): void => {
    const element = canvas.current
    if (element === null) return
    const context = element.getContext('2d')
    if (context === null) return
    drawMask(context, image, element.width, element.height)
  }
  const draw = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const element = canvas.current
    if (element === null) return
    const context = element.getContext('2d')
    if (context === null) return
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const scale = element.width / rect.width
    eraseAt(context, (event.clientX - rect.left) * scale, (event.clientY - rect.top) * scale, radius * scale)
  }
  const reset = (): void => {
    const element = canvas.current
    if (element === null) return
    const context = element.getContext('2d')
    if (context === null) {
      setError(messages.loadFailed)
      return
    }
    fillMask(context, element.width, element.height)
    setError(undefined)
  }
  const apply = (): void => {
    const element = canvas.current
    if (element === null) return
    const read = readMask(element)
    if (read === undefined) {
      setError(messages.loadFailed)
      return
    }
    // An untouched mask edits nothing, so it must not replace the attached reference.
    if (!hasTransparentPixel(read.pixels)) {
      setError(messages.empty)
      return
    }
    setError(undefined)
    setSaving(true)
    void onApply(read.dataUrl).then((saved) => {
      setSaving(false)
      if (saved) onClose()
      else setError(messages.saveFailed)
    })
  }

  return <Modal open title={messages.title} closeLabel={messages.close} onClose={onClose} className={clsx(css.maskModal)}
    footer={<>
      <Button variant="outline" disabled={saving} onClick={reset}>{messages.reset}</Button>
      <Button variant="primary" disabled={saving || !ready} aria-busy={saving} onClick={apply}>{messages.apply}</Button>
    </>}>
    <div className={css.maskStage}>
      <img className={css.maskSource} src={source.preview} alt={messages.sourceAlt}
        onLoad={(event) => { prepare(event.currentTarget) }} onError={() => { setError(messages.loadFailed) }} />
      <canvas ref={canvas} className={css.maskCanvas} aria-label={messages.canvas}
        onPointerDown={(event) => { painting.current = true; draw(event) }}
        onPointerMove={(event) => { if (painting.current) draw(event) }}
        onPointerUp={() => { painting.current = false }}
        onPointerCancel={() => { painting.current = false }}
        onPointerLeave={() => { painting.current = false }} />
    </div>
    <div className={css.maskControls}>
      <label className={css.maskBrushLabel} htmlFor={`${id}-brush`}>{messages.brush}</label>
      <input id={`${id}-brush`} className={css.maskRange} type="range" min={MASK_BRUSH_MIN} max={MASK_BRUSH_MAX} step={1}
        value={radius} disabled={saving} onChange={(event) => { setRadius(Number(event.target.value)) }} />
      <span className={css.maskValue}>{radius}</span>
    </div>
    {/* Loading the kept PNG after the source image restores the erased pixels without racing its sizing. */}
    {ready && initialMask !== undefined && <img hidden src={initialMask} alt=""
      onLoad={(event) => { restore(event.currentTarget) }} onError={() => { setError(messages.loadFailed) }} />}
    {error !== undefined && <p className={css.error} role="alert">{error}</p>}
  </Modal>
}

/** Asset categories in tab order. */
const ASSET_CATEGORIES: readonly AssetCategory[] = ['character', 'scene', 'prop']

/** Locale keys naming each asset category. */
const ASSET_CATEGORY_KEYS = {
  character: 'assetCategoryCharacter', scene: 'assetCategoryScene', prop: 'assetCategoryProp',
} as const

/** Host-side file extension, stripped when a selected file seeds an empty asset name. */
const FILE_EXTENSION = /\.[^./\\]+$/

/** Browser-only record of the workspace whose assets the panel showed last. */
const ASSET_WORKSPACE_KEY = 'dsh.directAi.assetWorkspace'

/** Asset panel state; a failure keeps the chosen workspace so a retry re-reads it. */
interface AssetState {
  phase: 'loading' | 'ready' | 'failed'
  workspaces: readonly WorkspaceSummary[]
  workspaceId: string | undefined
  records: readonly WorkspaceAsset[]
}

/** New asset values the panel reports to the page, which owns the Host write. */
interface AssetDraft {
  /** Image the user selected; its bytes are read by the page. */
  file: File
  /** Requested name; the Host derives the file name and resolves a collision. */
  title: string
  /** Category folder the image is filed under. */
  category: AssetCategory
}

/**
 * Read the workspace the asset panel showed last.
 * @returns the remembered workspace id, or undefined when none was stored.
 */
function rememberedAssetWorkspace(): string | undefined {
  try {
    return window.localStorage.getItem(ASSET_WORKSPACE_KEY) ?? undefined
  } catch (_storageUnavailable) {
    return undefined
  }
}

/**
 * Remember the workspace the user chose for later visits.
 * @param workspaceId - workspace whose assets the panel shows from now on.
 */
function rememberAssetWorkspace(workspaceId: string): void {
  try {
    window.localStorage.setItem(ASSET_WORKSPACE_KEY, workspaceId)
  } catch (_storageUnavailable) {
    // A browser that refuses storage keeps the choice for this page only.
  }
}

/**
 * Show and edit one workspace's asset folders: the workspace selector, category
 * tabs with counts, the thumbnail grid, per-asset reference and deletion actions,
 * and the add form. The page reads and writes the Host library, so this panel only
 * reports what the user asked for.
 * @param props.library - loaded workspaces, the chosen workspace, its records, and the status of the last read.
 * @param props.saving - whether a Host write is in flight, which locks the form and deletions.
 * @param props.created - whether the latest added asset should be acknowledged.
 * @param props.canUse - whether the reference upload path still accepts another image.
 * @param props.onSelectWorkspace - page handler switching the shown workspace.
 * @param props.onAdd - page handler storing one image; false keeps the form as typed.
 * @param props.onDelete - page handler removing one confirmed asset.
 * @param props.onUse - page handler attaching one asset as a reference image.
 * @param props.onReload - page handler reading the library again after a failure.
 * @param props.onClose - closes the panel.
 * @param props.t - localized copy supplied by the page.
 * @returns the asset library dialog.
 */
function AssetPanel({
  library, saving, created, canUse, onSelectWorkspace, onAdd, onDelete, onUse, onReload, onClose, t,
}: {
  library: AssetState
  saving: boolean
  created: boolean
  canUse: boolean
  onSelectWorkspace: (workspaceId: string) => void
  onAdd: (draft: AssetDraft) => Promise<boolean>
  onDelete: (asset: WorkspaceAsset) => void
  onUse: (asset: WorkspaceAsset) => void
  onReload: () => void
  onClose: () => void
  t: Translate
}): ReactNode {
  const id = useId()
  const picker = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState<AssetCategory>('character')
  const [draftCategory, setDraftCategory] = useState<AssetCategory>('character')
  const [draftCategoryOpen, setDraftCategoryOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftFile, setDraftFile] = useState<File>()
  const [confirming, setConfirming] = useState<string>()
  const workspace = library.workspaces.find(item => item.id === library.workspaceId)
  const visible = library.records.filter(asset => asset.category === category)
  const count = (value: AssetCategory): number => library.records.filter(asset => asset.category === value).length

  const chooseWorkspace = (workspaceId: string): void => {
    setWorkspaceOpen(false)
    // A pending deletion confirmation belongs to the folder that is no longer shown.
    setConfirming(undefined)
    onSelectWorkspace(workspaceId)
  }
  const chooseCategory = (next: AssetCategory): void => {
    setCategory(next)
    // A pending deletion confirmation belongs to the row that is no longer shown.
    setConfirming(undefined)
  }
  const chooseDraftCategory = (next: AssetCategory): void => {
    setDraftCategoryOpen(false)
    setDraftCategory(next)
  }
  const selectFile = (file: File): void => {
    setDraftFile(file)
    // A typed name wins over the one seeded from the file name.
    if (draftName.trim() === '') setDraftName(file.name.replace(FILE_EXTENSION, ''))
  }
  const save = (): void => {
    if (draftFile === undefined || saving || draftName.trim() === '') return
    const filed = draftCategory
    void onAdd({ file: draftFile, title: draftName.trim(), category: filed }).then((added) => {
      if (!added) return
      // The tab follows the new asset so it is visible without a second step.
      setCategory(filed)
      setDraftFile(undefined)
      setDraftName('')
    })
  }
  const remove = (asset: WorkspaceAsset): void => {
    if (confirming !== asset.name) { setConfirming(asset.name); return }
    setConfirming(undefined)
    onDelete(asset)
  }

  return <Modal open title={t('assets')} closeLabel={t('close')} onClose={onClose} className={clsx(css.assetModal)}
    footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}>
    <div className={css.assetBody}>
      <div className={css.selectorField}>
        <span id={`${id}-workspace-label`} className={css.fieldLabel}>{t('assetWorkspace')}</span>
        <Menu open={workspaceOpen} portal autoFocus minWidthFromAnchor selectedId={library.workspaceId}
          onClose={() => { setWorkspaceOpen(false) }} listClassName={css.serviceMenu}
          anchor={<Button variant="outline" className={css.selector} disabled={saving || library.workspaces.length === 0}
            aria-labelledby={`${id}-workspace-label ${id}-workspace-name`} aria-haspopup="menu" aria-expanded={workspaceOpen}
            onClick={() => { setWorkspaceOpen(value => !value) }}>
            <span id={`${id}-workspace-name`} className={css.selectorText}>{workspace?.title ?? t('assetWorkspace')}</span>
            <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
          </Button>}>
          {library.workspaces.map(item => <MenuItemButton key={item.id} current={item.id === library.workspaceId}
            onSelect={() => { chooseWorkspace(item.id) }}><span className={css.menuLabel}>{item.title}</span></MenuItemButton>)}
        </Menu>
      </div>
      {library.phase === 'loading' && <div className={css.skeleton} role="status" aria-label={t('loading')} />}
      {library.phase === 'failed' && <div className={css.notice}>
        <p className={css.error} role="alert">{t('assetStorageFailed')}</p>
        <Button variant="outline" size="sm" disabled={saving} onClick={onReload}>{t('retry')}</Button>
      </div>}
      {library.phase === 'ready' && library.workspaceId === undefined
        && <p className={css.hint}>{t('assetWorkspaceEmpty')}</p>}
      {library.workspaceId !== undefined && <>
        <SegmentedControl id={`${id}-asset-categories`} value={category} label={t('assetCategory')}
          options={ASSET_CATEGORIES.map(value => ({ value, label: `${t(ASSET_CATEGORY_KEYS[value])} (${count(value)})` }))}
          onChange={chooseCategory} />
        <section id={`${id}-asset-categories-${category}-panel`} role="tabpanel"
          aria-labelledby={`${id}-asset-categories-${category}`} className={css.assetBody}>
          {visible.length === 0 && library.phase === 'ready'
            ? <p className={css.hint}>{t('assetsEmpty')}</p>
            : <ul className={css.assetGrid}>
              {visible.map(asset => <li className={css.assetItem} key={asset.name}>
                <img className={css.assetThumb} src={asset.url} alt={asset.title} loading="lazy" />
                <p className={css.assetTitle}>{asset.title}</p>
                <p className={css.hint}>
                  {t(ASSET_CATEGORY_KEYS[asset.category])}<span aria-hidden="true"> · </span>
                  <time dateTime={new Date(asset.modifiedAt).toISOString()}>{new Date(asset.modifiedAt).toLocaleString()}</time>
                </p>
                <div className={css.assetActions}>
                  <Button variant="outline" size="sm" disabled={saving || !canUse}
                    aria-label={`${t('assetUseAsReference')} ${asset.title}`}
                    onClick={() => { onUse(asset) }}>{t('assetUseAsReference')}</Button>
                  <Button variant="outline" size="sm" disabled={saving}
                    aria-label={`${confirming === asset.name ? t('assetDeleteConfirm') : t('assetDelete')} ${asset.title}`}
                    onClick={() => { remove(asset) }}>
                    {confirming === asset.name ? t('assetDeleteConfirm') : t('assetDelete')}
                  </Button>
                </div>
              </li>)}
            </ul>}
        </section>
        <div className={css.assetAdd}>
          <p className={css.fieldLabel}>{t('assetAdd')}</p>
          <div className={css.assetAddRow}>
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden
              onChange={(event) => {
                const selected = event.target.files?.[0]
                event.target.value = ''
                if (selected !== undefined) selectFile(selected)
              }} />
            <Button variant="outline" size="sm" onClick={() => { picker.current?.click() }}>{t('assetAdd')}</Button>
            {draftFile !== undefined && <span className={css.hint}>{draftFile.name}</span>}
            <Input className={clsx(css.assetNameInput)} value={draftName} placeholder={t('assetName')} aria-label={t('assetName')}
              disabled={saving} onChange={(event) => { setDraftName(event.target.value) }} />
            <Menu open={draftCategoryOpen} portal autoFocus minWidthFromAnchor selectedId={draftCategory}
              onClose={() => { setDraftCategoryOpen(false) }} listClassName={css.serviceMenu}
              anchor={<Button variant="outline" size="sm" aria-label={t('assetCategory')} aria-haspopup="menu"
                aria-expanded={draftCategoryOpen} onClick={() => { setDraftCategoryOpen(value => !value) }}>
                {t(ASSET_CATEGORY_KEYS[draftCategory])}<IconChevronDownOutlineRegular size={14} aria-hidden="true" />
              </Button>}>
              {ASSET_CATEGORIES.map(value => <MenuItemButton key={value} current={value === draftCategory}
                onSelect={() => { chooseDraftCategory(value) }}>{t(ASSET_CATEGORY_KEYS[value])}</MenuItemButton>)}
            </Menu>
            <Button variant="primary" size="sm" disabled={saving || draftFile === undefined || draftName.trim() === ''}
              aria-busy={saving} onClick={save}>{t('save')}</Button>
          </div>
          {created && <p className={css.hint} role="status">{t('assetCreated')}</p>}
        </div>
      </>}
    </div>
  </Modal>
}

function RecentGenerations({ runs, onOpen, t }: {
  runs: readonly RunRecord[]
  onOpen: (run: RunRecord) => void
  t: Translate
}): ReactNode {
  return <ul className={css.recentList}>
    {runs.map((run) => {
      const media = imageFrames(run.frames)[0]
      const prompt = run.request.displayPrompt?.trim()
      const title = prompt === undefined || prompt === '' ? run.service.model : firstLine(prompt)
      const referenceCount = run.request.references?.length ?? 0
      return <li key={run.id}>
        <button type="button" className={css.recentItem} onClick={() => { onOpen(run) }}>
          {media === undefined
            ? <span className={css.thumbFallback} aria-hidden="true" />
            : <img className={css.thumb} src={media.url} alt={t('result')} loading="lazy" />}
          <span className={css.recentMeta}>
            <span className={css.recentTitle}>{title}</span>
            <span className={css.recentFacts}>
              <span>{run.service.model}</span>
              {referenceCount > 0 && <span>{t('referenceCount', { count: String(referenceCount) })}</span>}
              <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>
            </span>
          </span>
        </button>
      </li>
    })}
  </ul>
}

/**
 * Pair one run's prompt with its images and offer the prompt actions.
 * @param props.prompt - resolved prompt text, already shortened when only the request message remained.
 * @param props.run - service, model, start time and reference count of the shown run.
 * @param props.preset - localized preset name when this page submitted the run; history cannot record it.
 * @param props.onReuse - fills the composer with this prompt without submitting.
 * @param props.t - localized copy supplied by the page.
 * @returns the prompt block with its metadata and actions.
 */
function ResultPrompt({ prompt, run, preset, onReuse, t }: {
  prompt: string
  run: ShownRun | undefined
  preset: string | undefined
  onReuse: (prompt: string) => void
  t: Translate
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [copy, setCopy] = useState<'copied' | 'failed'>()
  const expandable = prompt.includes('\n') || prompt.length > PROMPT_EXPAND_LENGTH
  const copyPrompt = (): void => {
    setCopy(undefined)
    try {
      void navigator.clipboard.writeText(prompt).then(() => { setCopy('copied') }, () => { setCopy('failed') })
    } catch (_clipboardUnavailable) {
      setCopy('failed')
    }
  }

  return <section className={css.resultPrompt} aria-label={t('promptLabel')}>
    <p className={clsx(css.promptText, expanded && css.promptTextExpanded)}>{prompt}</p>
    {expandable && <button type="button" className={css.promptToggle} aria-expanded={expanded}
      onClick={() => { setExpanded(value => !value) }}>{expanded ? t('collapsePrompt') : t('expandPrompt')}</button>}
    {run !== undefined && <p className={css.resultMeta}>
      <span>{run.serviceName}</span>
      <span>{run.model}</span>
      <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>
      {run.referenceCount > 0 && <span>{t('referencesUsed', { count: String(run.referenceCount) })}</span>}
      {run.imageParams?.size !== undefined && <span>{t('resultSize', { size: run.imageParams.size })}</span>}
      {run.imageParams?.quality !== undefined
        && <span>{t('resultQuality', { quality: t(IMAGE_QUALITY_LABELS[run.imageParams.quality]) })}</span>}
      {run.imageParams?.count !== undefined
        && <span>{t('resultCount', { count: String(run.imageParams.count) })}</span>}
      {preset !== undefined && <span>{t('presetUsed', { name: preset })}</span>}
    </p>}
    <div className={css.promptActions}>
      <Button variant="outline" size="sm" onClick={copyPrompt}>{t('copyPrompt')}</Button>
      <Button variant="outline" size="sm" onClick={() => { onReuse(prompt) }}>{t('reusePrompt')}</Button>
    </div>
    {copy === 'copied' && <p className={css.hint} role="status">{t('promptCopied')}</p>}
    {copy === 'failed' && <p className={css.error} role="alert">{t('promptCopyFailed')}</p>}
  </section>
}

type SplitSection = { id: number; tiles: readonly SplitTile[] }

function ResultFigure({ frame, onView, t }: {
  frame: MediaFrame
  onView: (url: string) => void
  t: Translate
}): ReactNode {
  const image = useRef<HTMLImageElement>(null)
  const nextSectionId = useRef(0)
  const [splitting, setSplitting] = useState(false)
  const [splitError, setSplitError] = useState<string>()
  const [sections, setSections] = useState<readonly SplitSection[]>([])
  const [expanded, setExpanded] = useState<number>()

  const split = (): void => {
    const source = image.current
    if (source === null || splitting) return
    setSplitting(true)
    setSplitError(undefined)
    void splitGridImage(source, source.naturalWidth, source.naturalHeight, {
      notFound: t('gridNotFound'), tooLarge: t('gridTooLarge'), invalid: t('gridInvalid'),
    }).then((tiles) => {
      nextSectionId.current += 1
      const id = nextSectionId.current
      setSections(current => [...current, { id, tiles }])
      setExpanded(id)
      setSplitting(false)
    }, (cause: unknown) => {
      setSplitError(cause instanceof Error ? cause.message : t('splitFailed'))
      setSplitting(false)
    })
  }

  return <figure className={css.result}>
    <button type="button" className={css.resultButton} aria-label={t('imageStudioViewerDialog')}
      onClick={() => { onView(frame.url) }}>
      <img ref={image} className={css.resultImage} src={frame.url} alt={t('result')} loading="lazy" />
    </button>
    <figcaption className={css.resultActions}>
      <a className={css.download} href={downloadHref(frame.url)} target="_blank" rel="noopener noreferrer" download>
        <LinkIconMedium kind="url" href={frame.url} size={14} aria-hidden="true" />{t('download')}
      </a>
      <Button variant="outline" size="sm" disabled={splitting} onClick={split}>
        {splitting ? t('splitting') : t('splitGrid')}
      </Button>
    </figcaption>
    {splitError !== undefined && <p className={css.error} role="alert">{splitError}</p>}
    {sections.map((section) => {
      const open = section.id === expanded
      return <section className={css.splitSection} key={section.id} aria-label={t('splitResult')}>
        <button type="button" className={css.splitToggle} aria-expanded={open}
          onClick={() => { setExpanded(open ? undefined : section.id) }}>
          {t('splitResult')}
        </button>
        {open && <div className={css.splitTiles}>
          {section.tiles.map(tile => <div className={css.splitTile} key={tile.name}>
            <img className={css.splitImage} src={tile.dataUrl} alt={tile.name} />
            <a className={css.download} href={tile.dataUrl} download={tile.name}>
              <LinkIconMedium kind="url" href={tile.dataUrl} size={14} aria-hidden="true" />{t('download')}
            </a>
          </div>)}
        </div>}
      </section>
    })}
  </figure>
}

function ResultImages({ frames, onView, t }: {
  frames: readonly MediaFrame[]
  onView: (url: string) => void
  t: Translate
}): ReactNode {
  return <div className={css.results}>
    {frames.map(frame => <ResultFigure frame={frame} onView={onView} t={t} key={frame.url} />)}
  </div>
}

/** Batch sizes offered by the variant panel. */
const VARIANT_COUNTS = [2, 3, 4] as const

/** Batch size selected when the panel first opens. */
const DEFAULT_VARIANT_COUNT = 3

/** Styles checked when the panel first opens: the first batch-width styles. */
const DEFAULT_VARIANT_STYLES: readonly VariantStyleId[] = VARIANT_STYLES.slice(0, DEFAULT_VARIANT_COUNT)

/** Batch phase; `stopped` keeps the settled columns visible after a cancellation. */
type VariantPhase = 'idle' | 'running' | 'stopped'

/** The description and style set one batch was started with, so each column keeps its own prompt. */
interface VariantBatch {
  /** Description the batch appended every suffix to. */
  readonly base: string
  /** Styles the batch runs, in column order. */
  readonly styles: readonly VariantStyleId[]
}

/**
 * Render the inline variant comparison panel above the image tool row.
 * It runs the checked styles one after another over the current description and
 * parameters, keeps every settled column, and adopts a column's styled prompt
 * back into the composer without submitting.
 * @param props.base - current description every style appends its suffix to.
 * @param props.serviceId - configured image service the batch runs on.
 * @param props.parametersJson - explicit provider parameters forwarded to every style; blank omits them.
 * @param props.usable - whether a configured image service is selected.
 * @param props.running - whether the workspace's own run is in flight, which locks the panel.
 * @param props.openRun - opens one style's provider stream outside the displayed run.
 * @param props.onUse - adopts one column's styled prompt into the composer.
 * @param props.onClose - closes the panel, aborting a running batch.
 * @param props.onSettled - reports that the batch ended, so the page can re-read retained history.
 * @param props.t - localized copy supplied by the page.
 * @returns the panel with its count, style, progress, start/stop and result grid controls.
 */
function VariantPanel({
  base, serviceId, parametersJson, usable, running, openRun, onUse, onClose, onSettled, t,
}: {
  base: string
  serviceId: ServiceId | undefined
  parametersJson: string
  usable: boolean
  running: boolean
  openRun: VariantRun
  onUse: (prompt: string) => void
  onClose: () => void
  onSettled: () => void
  t: Translate
}): ReactNode {
  const id = useId()
  const [count, setCount] = useState<number>(DEFAULT_VARIANT_COUNT)
  const [styles, setStyles] = useState<readonly VariantStyleId[]>(DEFAULT_VARIANT_STYLES)
  const [phase, setPhase] = useState<VariantPhase>('idle')
  const [batch, setBatch] = useState<VariantBatch>()
  const [outcomes, setOutcomes] = useState<readonly VariantOutcome[]>([])
  const active = useRef<AbortController>()
  const busy = phase === 'running'
  const total = batch?.styles.length ?? Math.min(count, styles.length)
  // Columns already settled occupy the front of the batch, so the next one is its index plus one.
  const position = Math.min(outcomes.length + 1, Math.max(total, 1))
  const startable = !busy && usable && !running && serviceId !== undefined
    && base.trim() !== '' && styles.length > 0

  const stop = (): void => {
    active.current?.abort()
    active.current = undefined
    setPhase('stopped')
  }
  // Closing the panel drops the batch instead of leaving it writing into unmounted state.
  const panelRef = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) return
    active.current?.abort()
    active.current = undefined
  }, [])
  const chooseCount = (next: number): void => {
    setCount(next)
  }
  const toggleStyle = (styleId: VariantStyleId, checked: boolean): void => {
    // Palette order keeps the batch order stable however the boxes are toggled.
    setStyles(current => VARIANT_STYLES.filter(item => item === styleId ? checked : current.includes(item)))
  }
  const start = (): void => {
    if (!startable) return
    const batchStyles = styles.slice(0, count)
    const controller = new AbortController()
    active.current = controller
    setBatch({ base, styles: batchStyles })
    setOutcomes([])
    setPhase('running')
    void runVariants({
      serviceId, base, styleIds: batchStyles, parametersJson, signal: controller.signal, openRun,
    }, {
      onOutcome: (outcome) => {
        if (active.current !== controller) return
        setOutcomes(current => [...current, outcome])
      },
    }).then((settled) => {
      if (active.current === controller) {
        active.current = undefined
        setOutcomes(settled)
        setPhase(controller.signal.aborted ? 'stopped' : 'idle')
      }
      // The Host retained one record per style the batch opened, including a cancelled one.
      onSettled()
    })
  }

  return <div className={css.variantPanel} role="region" aria-label={t('variants')} ref={panelRef}>
    <div className={css.variantHeader}>
      <h2 className={css.assistTitle}>{t('variants')}</h2>
      <Button variant="outline" size="sm" onClick={onClose}>{t('close')}</Button>
    </div>
    <div className={css.variantControls}>
      <div className={css.variantCountRow} role="group" aria-labelledby={`${id}-count`}>
        <span id={`${id}-count`} className={css.fieldLabel}>{t('variantCount')}</span>
        {VARIANT_COUNTS.map(value => <Pill key={value} active={value === count} aria-pressed={value === count}
          disabled={busy} onClick={() => { chooseCount(value) }}>{String(value)}</Pill>)}
      </div>
      <div className={css.variantStyles} role="group" aria-labelledby={`${id}-styles`}>
        <span id={`${id}-styles`} className={css.fieldLabel}>{t('variantStyles')}</span>
        {VARIANT_STYLES.map(styleId => <Checkbox key={styleId} checked={styles.includes(styleId)}
          disabled={busy} label={t(VARIANT_STYLE_LABELS[styleId])}
          onChange={(checked) => { toggleStyle(styleId, checked) }} />)}
      </div>
    </div>
    <div className={css.variantActions}>
      {busy
        ? <Button variant="outline" size="sm" onClick={stop}>{t('variantStop')}</Button>
        : <Button variant="primary" size="sm" disabled={!startable} onClick={start}>{t('variantStart')}</Button>}
      {busy && <p className={css.hint} role="status">
        {t('variantProgress', { current: String(position), total: String(total) })}
      </p>}
      {phase === 'stopped' && <p className={css.hint} role="status">{t('cancelled')}</p>}
    </div>
    {outcomes.length === 0
      ? <p className={css.hint}>{t('variantEmpty')}</p>
      : <ul className={css.variantGrid}>
        {outcomes.map(outcome => <li className={css.variantColumn} key={outcome.styleId}>
          <p className={css.variantStyleName}>{t(VARIANT_STYLE_LABELS[outcome.styleId])}</p>
          {outcome.images.map(url => <img key={url} className={css.variantImage} src={url}
            alt={t('result')} loading="lazy" />)}
          {outcome.status === 'failed' && <p className={css.error} role="alert">
            {t('variantFailed')}
            {outcome.error !== undefined && <code className={css.errorCode}>{outcome.error}</code>}
          </p>}
          <div className={css.variantColumnActions}>
            {outcome.images.map((url, index) => <a key={url} className={css.download} href={downloadHref(url)}
              target="_blank" rel="noopener noreferrer" download>
              <LinkIconMedium kind="url" href={url} size={14} aria-hidden="true" />
              {outcome.images.length > 1 ? `${t('download')} ${index + 1}` : t('download')}
            </a>)}
            <Button variant="outline" size="sm" disabled={outcome.images.length === 0}
              onClick={() => { onUse(variantPrompt(batch?.base ?? base, outcome.styleId)) }}>
              {t('variantUse')}
            </Button>
          </div>
        </li>)}
      </ul>}
  </div>
}

/**
 * Render the image-generation workspace.
 * @param props - configured services and retained runs plus controller actions.
 * @returns the mode bar, recent generations, result area and generation form.
 */
export function ImageStudio({
  useCatalog, useInteraction, useHistory, refresh, select, submit, uploadReference, stop, restore, backToAgent,
  assetLibrary, assistChat, variantRun, t,
}: ImageStudioProps): ReactNode {
  const catalog = useCatalog(value => value)
  const interaction = useInteraction(value => value)
  const history = useHistory(value => value)
  const id = useId()
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<ImageModeId>('none')
  // A retained run does not record its composer preset, so only this page can show it.
  const [submittedPreset, setSubmittedPreset] = useState<PromptPresetId>()
  const promptBox = useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(false)
  // Undefined only when this browser never remembered parameters, so a first-time composer keeps provider defaults.
  const [params, setParams] = useState<ImageParams | undefined>(() => storedImageParams())
  const [assistOpen, setAssistOpen] = useState(false)
  const [variantOpen, setVariantOpen] = useState(false)
  // The dismissed description text: editing it brings the suggestion back.
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string>()
  const [viewer, setViewer] = useState<string>()
  const [references, setReferences] = useState<readonly SelectedReference[]>([])
  const [uploading, setUploading] = useState(0)
  const [mask, setMask] = useState<AppliedMask>()
  const [maskOpen, setMaskOpen] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [assetState, setAssetState] = useState<AssetState>({
    phase: 'loading', workspaces: [], workspaceId: undefined, records: [],
  })
  const [assetSaving, setAssetSaving] = useState(false)
  const [assetCreated, setAssetCreated] = useState(false)
  // Every read takes the next ordinal, so a slower earlier read cannot overwrite a later one.
  const assetRead = useRef(0)
  const filePicker = useRef<HTMLInputElement>(null)
  const previews = useRef(new Set<string>())
  // A stable ref callback releases every outstanding object URL when the page unmounts.
  const mounted = useRef(true)
  const releasePreviews = useCallback((): void => {
    for (const url of previews.current) URL.revokeObjectURL(url)
    previews.current.clear()
  }, [])
  const pageRef = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) return
    mounted.current = false
    releasePreviews()
  }, [releasePreviews])
  const services = catalog.services.filter(service => service.capability === 'image' && service.configured)
  const runs = history.records.filter(run => run.service.capability === 'image')
  const selected = services.find(service => service.id === interaction.serviceId)
  const running = interaction.phase === 'running'
  const usable = catalog.phase === 'ready' && selected !== undefined
  const images = imageFrames(interaction.frames)
  const atReferenceLimit = references.length >= MAX_REFERENCES
  // A mask describes exactly one reference, so it only applies while exactly one stays attached.
  const onlyReference = references[0]
  const maskSource = references.length === 1 ? onlyReference : undefined
  const appliedMask = mask !== undefined && mask.reference === maskSource?.preview ? mask : undefined
  const maskMessages: MaskEditorMessages = {
    title: t('maskTitle'),
    sourceAlt: t('maskSourcePreview'),
    canvas: t('maskSourcePreview'),
    brush: t('maskBrush'),
    reset: t('maskReset'),
    apply: t('maskApply'),
    empty: t('maskEmpty'),
    loadFailed: t('maskEditorFailed'),
    saveFailed: t('referenceUploadFailed'),
    close: t('close'),
  }
  // Template presets need exactly one reference image and supply their own instruction, so the
  // user's description is optional until the free preset is selected again.
  const preset: PromptPresetId = mode === 'mask' ? 'none' : mode
  const maskEditing = mode === 'mask'
  const templatePreset = preset !== 'none'
  const missingPresetReference = templatePreset && references.length !== 1
  const promptMissing = preset === 'none' && prompt.trim() === ''
  const modeLabelKey = IMAGE_MODES.find(option => option.id === mode)?.labelKey ?? 'presetNone'
  const modeLabel = t(modeLabelKey)
  const paired = images.length > 0 ? pairedPrompt(interaction) : undefined
  const submittedPresetKey = PROMPT_PRESETS.find(option => option.id === submittedPreset)?.labelKey
  const shownPreset = submittedPresetKey === undefined ? undefined : t(submittedPresetKey)
  // The assistant calls a configured chat service; generation and expansion stay separate requests.
  const assistantServices = chatServices(catalog.services)
  // The batch forwards the composer's own selection, so every style reports the same parameters.
  const variantParametersJson = params === undefined ? '' : imageParamsJson(params)
  const suggestion = pendingSuggestion(prompt, references.length, preset, params)
  // A dismissal hides only the suggestion for the text the user dismissed.
  const visibleSuggestion = suggestion !== undefined && prompt !== dismissedSuggestion ? suggestion : undefined

  const upload = async (file: File): Promise<void> => {
    const preview = URL.createObjectURL(file)
    previews.current.add(preview)
    setUploading(count => count + 1)
    const reference = await uploadReference(file)
    if (!mounted.current) {
      previews.current.delete(preview)
      URL.revokeObjectURL(preview)
      return
    }
    setUploading(count => count - 1)
    if (reference === undefined) {
      previews.current.delete(preview)
      URL.revokeObjectURL(preview)
      return
    }
    setReferences(current => [...current, { ref: reference, preview }])
    // Adding a second reference breaks the one-reference mask rule.
    setMask(undefined)
  }
  const addReferences = (files: readonly File[]): void => {
    for (const file of files.slice(0, MAX_REFERENCES - references.length)) void upload(file)
  }
  const removeReference = (index: number): void => {
    const removed = references[index]
    if (removed === undefined) return
    previews.current.delete(removed.preview)
    URL.revokeObjectURL(removed.preview)
    setReferences(current => current.filter(item => item !== removed))
    // A mask only exists beside the single reference, so any removal detaches it.
    setMask(undefined)
  }
  const saveMask = async (dataUrl: string): Promise<boolean> => {
    const current = references[0]
    if (current === undefined) return false
    const file = maskFileFromDataUrl(dataUrl, maskFileName(current.ref.name ?? ''))
    if (file === undefined) return false
    const reference = await uploadReference(file)
    if (!mounted.current || reference === undefined) return false
    setMask({ reference: current.preview, dataUrl, ref: reference })
    return true
  }
  /** Read one workspace's assets; a read started later supersedes this one. */
  const readWorkspaceAssets = async (workspaceId: string): Promise<void> => {
    const ordinal = ++assetRead.current
    setAssetState(current => ({ ...current, phase: 'loading', records: [] }))
    try {
      const records = await assetLibrary.list(workspaceId)
      if (!mounted.current || ordinal !== assetRead.current) return
      setAssetState(current => ({ ...current, phase: 'ready', records }))
    } catch (_assetReadFailed) {
      if (!mounted.current || ordinal !== assetRead.current) return
      setAssetState(current => ({ ...current, phase: 'failed', records: [] }))
    }
  }
  // The library is read when the panel opens and after each write, never on an effect.
  const loadLibrary = async (): Promise<void> => {
    const ordinal = ++assetRead.current
    setAssetState(current => ({ ...current, phase: 'loading', records: [] }))
    let workspaces: readonly WorkspaceSummary[]
    try {
      workspaces = await assetLibrary.workspaces()
    } catch (_workspaceReadFailed) {
      if (!mounted.current || ordinal !== assetRead.current) return
      setAssetState(current => ({ ...current, phase: 'failed', records: [] }))
      return
    }
    if (!mounted.current || ordinal !== assetRead.current) return
    const remembered = rememberedAssetWorkspace()
    const chosen = workspaces.find(item => item.id === remembered) ?? workspaces[0]
    setAssetState({
      phase: chosen === undefined ? 'ready' : 'loading', workspaces, workspaceId: chosen?.id, records: [],
    })
    if (chosen !== undefined) await readWorkspaceAssets(chosen.id)
  }
  const openAssets = (): void => {
    setAssetsOpen(true)
    setAssetCreated(false)
    void loadLibrary()
  }
  const selectAssetWorkspace = (workspaceId: string): void => {
    rememberAssetWorkspace(workspaceId)
    setAssetCreated(false)
    setAssetState(current => ({ ...current, workspaceId, records: [] }))
    void readWorkspaceAssets(workspaceId)
  }
  const addAsset = async (draft: AssetDraft): Promise<boolean> => {
    const workspaceId = assetState.workspaceId
    if (workspaceId === undefined) return false
    setAssetSaving(true)
    setAssetCreated(false)
    try {
      const upload = await readAssetUpload(draft.file)
      await assetLibrary.save({ workspaceId, category: draft.category, title: draft.title, data: upload.data, mime: upload.mime })
      if (!mounted.current) return false
      setAssetSaving(false)
      setAssetCreated(true)
      await readWorkspaceAssets(workspaceId)
      return true
    } catch (_assetWriteFailed) {
      if (!mounted.current) return false
      setAssetSaving(false)
      setAssetState(current => ({ ...current, phase: 'failed' }))
      return false
    }
  }
  const deleteAsset = (asset: WorkspaceAsset): void => {
    const workspaceId = assetState.workspaceId
    if (workspaceId === undefined || assetSaving) return
    setAssetSaving(true)
    setAssetCreated(false)
    void assetLibrary.remove(workspaceId, asset.category, asset.name).then(() => {
      if (!mounted.current) return
      setAssetSaving(false)
      void readWorkspaceAssets(workspaceId)
    }, (_assetRemoveFailed: unknown) => {
      if (!mounted.current) return
      setAssetSaving(false)
      setAssetState(current => ({ ...current, phase: 'failed' }))
    })
  }
  // A stored asset becomes a reference through the same upload path as a manual file choice.
  const useAsset = (asset: WorkspaceAsset): void => {
    if (running || uploading > 0 || atReferenceLimit) return
    void assetFileFromUrl(asset.url, asset.title).then((file) => {
      if (!mounted.current) return
      setAssetsOpen(false)
      void upload(file)
    }, (_assetFetchFailed: unknown) => {
      if (!mounted.current) return
      setAssetState(current => ({ ...current, phase: 'failed' }))
    })
  }
  const submitRequest = (event: FormEvent): void => {
    event.preventDefault()
    if (!usable || running || promptMissing || missingPresetReference) return
    const submitted = prompt
    const submittedPrompt = composePrompt(preset, submitted)
    // The Host retains the user's own words for the result card, so a preset template never enters it.
    const displayPrompt = submitted.trim() === '' ? undefined : submitted
    const submittedReferences = references.length > 0 ? references.map(item => item.ref) : undefined
    const submittedMask = appliedMask?.ref
    const parametersJson = params === undefined ? '' : imageParamsJson(params)
    const settled = submit(submittedPrompt, '', parametersJson, submittedReferences, submittedMask, displayPrompt)
    void settled.then((completed) => {
      if (!completed) return
      setPrompt(current => current === submitted ? '' : current)
      setSubmittedPreset(preset === 'none' ? undefined : preset)
      releasePreviews()
      setReferences([])
      setMask(undefined)
    })
  }
  const openRun = (run: RunRecord): void => {
    if (running) return
    setViewer(undefined)
    // History cannot tell which composer preset produced the run.
    setSubmittedPreset(undefined)
    restore(run)
  }
  // Reuse fills the composer only; the user still decides when to spend another request.
  const reusePrompt = (text: string): void => {
    setPrompt(text)
    promptBox.current?.focus()
  }
  const selectService = (serviceId: ServiceId): void => {
    if (running) return
    setMenuOpen(false)
    select(serviceId)
  }
  const selectMode = (next: ImageModeId): void => {
    if (running) return
    setModeMenuOpen(false)
    // Switching the mode leaves the typed description and the attached references untouched.
    setMode(next)
  }
  // The remembered selection is read when the dialog opens, so no render-time browser storage access
  // and no effect are involved. An untouched composer keeps sending provider defaults.
  const openParams = (): void => {
    if (running || !usable) return
    if (params === undefined) setParams(storedImageParams() ?? DEFAULT_IMAGE_PARAMS)
    setParamsOpen(value => !value)
  }
  const changeParams = (next: ImageParams): void => {
    setParams(next)
    rememberImageParams(next)
  }
  // Applying a suggestion changes only the composer selection; the user still submits explicitly.
  const applySuggestion = (next: ParamSuggestion): void => {
    if (running) return
    const applied = withSuggestion(params ?? DEFAULT_IMAGE_PARAMS, next)
    setParams(applied)
    rememberImageParams(applied)
  }
  // Adopting writes the expanded text into the description; it never submits or changes parameters.
  const adoptAssist = (text: string): void => {
    setPrompt(text)
    promptBox.current?.focus()
  }
  // A variant column writes its styled prompt into the description and closes the panel; it never submits.
  const useVariant = (text: string): void => {
    setPrompt(text)
    setVariantOpen(false)
    promptBox.current?.focus()
  }
  const openMaskEditor = (): void => {
    if (running || maskSource === undefined) return
    setMaskOpen(true)
  }
  const clearMask = (): void => { setMask(undefined) }

  return (
    <div className={css.page} ref={pageRef}>
      <div className={css.pageBody}>
        <header className={css.header}>
          <div className={css.toolbar}>
            <div className={css.modeBar}>
              <ModeBar mode="image" t={t} onSelect={(mode) => { if (mode === 'chat') backToAgent() }} />
            </div>
          </div>
          <div className={css.heading}>
            <h1 className={css.title}>{t('imageStudio')}</h1>
            <p className={css.description}>{t('imageStudioDescription')}</p>
          </div>
        </header>

        <details className={css.recent}>
          <summary className={css.summary}>{t('imageStudioRecent')}</summary>
          <div className={css.recentBody}>
            {history.phase === 'loading' && <div className={css.skeleton} role="status" aria-label={t('loading')} />}
            {history.phase === 'error' && <p className={css.error} role="alert">{t('historyError')}</p>}
            {history.phase === 'ready' && runs.length === 0 && <p className={css.hint}>{t('imageStudioRecentEmpty')}</p>}
            {runs.length > 0 && <RecentGenerations runs={runs} onOpen={openRun} t={t} />}
          </div>
        </details>

        <section className={css.stage} aria-label={t('result')}>
          {catalog.phase === 'loading' && <div className={css.skeleton} role="status" aria-label={t('loading')} />}
          {(catalog.phase === 'error' || (catalog.error !== undefined && catalog.error !== 'referenceUploadFailed'))
            && <p className={css.error} role="alert">{t(catalog.error ?? 'loadError')}</p>}
          {catalog.phase === 'ready' && services.length === 0 && <div className={css.emptyState}>
            <p className={css.emptyTitle}>{t('imageStudioSetup')}</p>
          </div>}
          {images.length > 0 && <div className={css.resultCard}>
            {paired !== undefined && <ResultPrompt key={paired} prompt={paired} run={interaction.run}
              preset={shownPreset} onReuse={reusePrompt} t={t} />}
            <ResultImages frames={images} onView={setViewer} t={t} />
          </div>}
          {running && <p className={css.status} role="status"><StateDot state="ongoing" />{t('running')}</p>}
          {(interaction.error !== undefined || interaction.phase === 'failed') && <p className={css.error} role="alert">
            {t(interaction.error ?? 'requestError')}
            {interaction.errorCode !== undefined && <code className={css.errorCode}>{interaction.errorCode}</code>}
          </p>}
          {interaction.phase === 'cancelled' && <p className={css.warning} role="status">{t('cancelled')}</p>}
        </section>

        <form className={css.composer} onSubmit={submitRequest}>
          {references.length > 0 && <ul className={css.referenceList}>
            {references.map((item, index) => <li className={css.referenceItem} key={item.preview}>
              <div className={css.referenceThumbWrap}>
                <img className={css.referenceThumb} src={item.preview} alt={t('references')} />
                {appliedMask?.reference === item.preview && <span className={css.maskBadge}>{t('maskReady')}</span>}
              </div>
              <button type="button" className={css.referenceRemove} disabled={running}
                aria-label={`${t('removeReference')} ${index + 1}`} onClick={() => { removeReference(index) }}>
                {t('remove')}
              </button>
            </li>)}
          </ul>}
          <textarea ref={promptBox} id={`${id}-prompt`} className={css.prompt} rows={4} value={prompt}
            aria-label={t('imageStudioPrompt')} aria-describedby={`${id}-prompt-count`} maxLength={PROMPT_LIMIT}
            placeholder={t('imageStudioPlaceholder')}
            disabled={running || !usable} onChange={(event) => { setPrompt(event.target.value) }} />
          {assistOpen && <PromptAssistant services={assistantServices} source={prompt} assist={assistChat}
            onAdopt={adoptAssist} onClose={() => { setAssistOpen(false) }} t={t} />}
          {variantOpen && <VariantPanel base={prompt} serviceId={selected?.id} parametersJson={variantParametersJson}
            usable={usable} running={running} openRun={variantRun} onUse={useVariant}
            onSettled={() => { void refresh() }} onClose={() => { setVariantOpen(false) }} t={t} />}
          {visibleSuggestion !== undefined && <div className={css.suggestionBar} role="group" aria-label={t('suggestions')}>
            <p className={css.suggestionText}>{t('suggestionSummary', {
              ratio: visibleSuggestion.ratio, resolution: visibleSuggestion.resolution,
              quality: visibleSuggestion.quality, count: String(visibleSuggestion.count),
              reason: t(SUGGESTION_REASON_KEYS[visibleSuggestion.reason]),
            })}</p>
            <div className={css.suggestionActions}>
              <Button variant="outline" size="sm" disabled={running}
                onClick={() => { applySuggestion(visibleSuggestion) }}>{t('suggestionApply')}</Button>
              <Button variant="ghost" size="sm"
                onClick={() => { setDismissedSuggestion(prompt) }}>{t('suggestionIgnore')}</Button>
            </div>
          </div>}
          <div className={css.composerToolbar}>
            <div className={css.composerTools}>
              <input ref={filePicker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden
                onChange={(event) => {
                  // The FileList is live: copying first keeps the selection after the value reset.
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  addReferences(files)
                }} />
              <Button variant="outline" size="sm" className={css.toolIcon} disabled={running || !usable || uploading > 0 || atReferenceLimit}
                aria-label={t('addReference')} title={t('addReference')} icon={<IconPlusOutlineRegular size={16} />}
                onClick={() => { filePicker.current?.click() }} />
              <Menu open={modeMenuOpen} portal autoFocus minWidthFromAnchor selectedId={mode}
                onClose={() => { setModeMenuOpen(false) }} listClassName={css.serviceMenu}
                anchor={<Button variant="outline" size="sm" className={css.toolButton} disabled={running || !usable}
                  aria-label={`${t('generationMode')}: ${modeLabel}`} aria-haspopup="menu" aria-expanded={modeMenuOpen}
                  onClick={() => { setModeMenuOpen(value => !value) }}>
                  <span className={css.toolText}>{modeLabel}</span>
                  <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
                </Button>}>
                {IMAGE_MODES.map(option => <MenuItemButton key={option.id} current={option.id === mode}
                  onSelect={() => { selectMode(option.id) }}><span className={css.menuLabel}>{t(option.labelKey)}</span></MenuItemButton>)}
              </Menu>
              <Button variant="outline" size="sm" className={css.toolButton} disabled={running} onClick={openAssets}>{t('assets')}</Button>
              <Button variant="outline" size="sm" className={css.toolButton} disabled={running || assistantServices.length === 0}
                aria-label={t('promptAssist')} aria-expanded={assistOpen}
                aria-describedby={assistantServices.length === 0 ? `${id}-assist-hint` : undefined}
                icon={<IconSparkleRegular size={14} />}
                onClick={() => { setAssistOpen(value => !value) }}>{t('promptAssist')}</Button>
              <Button variant="outline" size="sm" className={css.toolButton} disabled={running || !usable}
                aria-haspopup="dialog" aria-expanded={paramsOpen} onClick={openParams}>{t('imageParams')}</Button>
              <Button variant="outline" size="sm" className={css.toolButton} disabled={running || !usable}
                aria-expanded={variantOpen} onClick={() => { setVariantOpen(value => !value) }}>{t('variants')}</Button>
              {maskEditing && <Button variant="outline" size="sm" className={css.toolButton}
                disabled={running || !usable || uploading > 0 || maskSource === undefined} onClick={openMaskEditor}>
                {appliedMask === undefined ? t('editMask') : t('maskReedit')}
              </Button>}
              {appliedMask !== undefined && <Button variant="outline" size="sm" className={css.toolButton}
                disabled={running} onClick={clearMask}>{t('maskClear')}</Button>}
            </div>
            <div className={css.composerMeta}>
              <span id={`${id}-prompt-count`} className={css.counter}>{t('promptCounter', { count: String(prompt.length) })}</span>
              {services.length > 0 && <Menu open={menuOpen} portal autoFocus minWidthFromAnchor selectedId={selected?.id}
                onClose={() => { setMenuOpen(false) }} listClassName={css.serviceMenu}
                anchor={<Button variant="outline" size="sm" className={css.toolButton} disabled={running || catalog.phase !== 'ready'}
                  aria-label={`${t('imageStudioSelectService')}: ${selected?.name ?? t('selectService')}`}
                  aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value) }}>
                  <span className={css.toolText}>{selected?.name ?? t('selectService')}</span>
                  <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
                </Button>}>
                {services.map(service => <MenuItemButton key={service.id} current={service.id === interaction.serviceId}
                  onSelect={() => { selectService(service.id) }}><span className={css.menuLabel}>{service.name}</span></MenuItemButton>)}
              </Menu>}
              {running
                ? <Button variant="outline" onClick={stop}>{t('stop')}</Button>
                : <Button type="submit" variant="primary"
                  disabled={!usable || promptMissing || missingPresetReference}>{t('generate')}</Button>}
            </div>
          </div>
          <div className={css.composerHints}>
            {uploading > 0 && <p className={css.hint} role="status">{t('loading')}</p>}
            {assistantServices.length === 0 && <p id={`${id}-assist-hint`} className={css.hint}>{t('promptAssistNoService')}</p>}
            {atReferenceLimit && <p className={css.hint}>{t('referenceLimit', { max: String(MAX_REFERENCES) })}</p>}
            {references.length > 0 && <p className={css.hint}>{t('referenceEditHint')}</p>}
            {templatePreset && <p className={css.hint}>{t('presetTemplateHint')}</p>}
            {missingPresetReference && <p className={css.hint} role="status">{t('presetNeedsOneReference')}</p>}
            {maskEditing && maskSource === undefined
              && <p className={css.hint} role="status">{t('maskNeedsOneReference')}</p>}
            {catalog.error === 'referenceUploadFailed' && <p className={css.error} role="alert">{t('referenceUploadFailed')}</p>}
            <p className={css.hint}>{t('directNotice')}</p>
          </div>
        </form>
      </div>
      {paramsOpen && params !== undefined && <ImageParamsDialog params={params} reference={onlyReference?.ref}
        onChange={changeParams} onClose={() => { setParamsOpen(false) }} t={t} />}
      {viewer !== undefined && <ImageLightbox src={viewer} alt={t('result')}
        labels={{ dialog: t('imageStudioViewerDialog'), close: t('close') }} onClose={() => { setViewer(undefined) }} />}
      {maskOpen && maskSource !== undefined && <MaskEditor key={maskSource.preview} source={maskSource}
        initialMask={appliedMask?.dataUrl} messages={maskMessages} onApply={saveMask}
        onClose={() => { setMaskOpen(false) }} />}
      {assetsOpen && <AssetPanel library={assetState} saving={assetSaving} created={assetCreated}
        canUse={!running && uploading === 0 && !atReferenceLimit} onSelectWorkspace={selectAssetWorkspace}
        onAdd={addAsset} onDelete={deleteAsset} onUse={useAsset}
        onReload={() => { void loadLibrary() }} onClose={() => { setAssetsOpen(false) }} t={t} />}
    </div>
  )
}
