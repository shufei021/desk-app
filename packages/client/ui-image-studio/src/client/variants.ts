/**
 * Serial batch generation of one description across several visual styles.
 *
 * Every style opens its own provider stream through the page-supplied opener and
 * never enters the workspace's displayed run: the batch owns its streams,
 * cancellation and outcomes, so the result area and the interaction state stay
 * untouched until the user adopts a column. One provider stream runs at a time,
 * and a failed style does not stop the batch.
 */
import type { DirectFrame, DirectRequest, ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import { variantPrompt, type VariantStyleId } from './variant-styles.ts'

/** Longest retained display text the Host accepts beside a run. */
const DISPLAY_PROMPT_LIMIT = 4000

/** One provider stream as a batch consumes it: frames plus explicit cancellation. */
export interface VariantStream extends AsyncIterable<DirectFrame> {
  /** Cancel the logical stream; safe to call once iteration has finished. */
  dispose(): void
}

/** One style's result column. */
export interface VariantOutcome {
  /** Style whose suffix this column's request carried. */
  readonly styleId: VariantStyleId
  /** `done` only after the provider confirmed completion; an interrupted or short stream is `failed`. */
  readonly status: 'done' | 'failed'
  /** Media URLs collected in provider order, kept even when the stream failed. */
  readonly images: readonly string[]
  /** Provider error code or message; absent when the stream ended without a completion or error. */
  readonly error?: string
}

/**
 * Open one provider stream for a batch style.
 * @param request - the exact styled request to stream.
 * @param signal - cancellation linked to this style only.
 * @returns the open stream, which the batch iterates and then disposes.
 */
export type VariantRun = (request: DirectRequest, signal: AbortSignal) => VariantStream

/** Everything one batch needs, including the page-bound stream opener. */
export interface VariantInput {
  /** Configured image service the whole batch runs on. */
  readonly serviceId: ServiceId
  /** User description; each style appends its own suffix. */
  readonly base: string
  /** Styles to run, in column order; the caller has already applied the batch count. */
  readonly styleIds: readonly VariantStyleId[]
  /** Explicit provider parameters forwarded unchanged; blank omits them. */
  readonly parametersJson: string
  /** Batch cancellation: aborting it stops the current style and every later one. */
  readonly signal: AbortSignal
  /** Opens one style's stream outside the workspace's displayed run. */
  readonly openRun: VariantRun
}

/** Live notifications for the panel's progress and result grid. */
export interface VariantHandlers {
  /**
   * Observe one settled style in completion order.
   * @param outcome - the settled column.
   */
  readonly onOutcome?: (outcome: VariantOutcome) => void
}

/**
 * Read a provider failure's stable code, else its message.
 * @param error - value thrown by the stream or its opener.
 * @returns the code, the message, or undefined when the value carries neither.
 */
function failureReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'string' && error.code !== '') return error.code
  if ('message' in error && typeof error.message === 'string' && error.message !== '') return error.message
  return undefined
}

/**
 * Read the batch cancellation flag.
 * @param signal - batch or style cancellation.
 * @returns whether the signal is already aborted.
 */
function cancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Run one style and collect its media URLs.
 * @param input - batch input supplying the service, parameters and opener.
 * @param styleId - style this run appends to the description.
 * @param signal - cancellation linked to the batch.
 * @returns the style's column; `done` requires the provider's done frame.
 */
async function runStyle(input: VariantInput, styleId: VariantStyleId, signal: AbortSignal): Promise<VariantOutcome> {
  const prompt = variantPrompt(input.base, styleId)
  const parametersJson = input.parametersJson.trim()
  const images: string[] = []
  let completed = false
  try {
    const stream = input.openRun({
      serviceId: input.serviceId,
      messages: [{ role: 'user', content: prompt }],
      ...(parametersJson === '' ? {} : { parametersJson }),
      // The retained description is the styled prompt, so history names the variant that produced the image.
      // A description at the composer's limit plus a suffix exceeds the Host bound, so it is omitted rather than failing.
      ...(prompt.length <= DISPLAY_PROMPT_LIMIT ? { displayPrompt: prompt } : {}),
    }, signal)
    try {
      for await (const frame of stream) {
        if (signal.aborted) break
        if (frame.type === 'media') images.push(frame.url)
        completed ||= frame.type === 'done'
      }
    } finally { stream.dispose() }
  } catch (error) {
    const reason = failureReason(error)
    return { styleId, status: 'failed', images, ...(reason === undefined ? {} : { error: reason }) }
  }
  return { styleId, status: completed ? 'done' : 'failed', images }
}

/**
 * Generate one column per style, strictly one provider stream at a time.
 *
 * A failed style is recorded and the next one runs. Aborting `input.signal`
 * stops the current stream and every later style; the interrupted column is
 * dropped because it produced no confirmed result, while settled columns stay.
 * @param input - description, styles, parameters, cancellation and stream opener.
 * @param handlers - optional live progress notifications.
 * @returns every column that settled before the batch ended, in completion order.
 */
export async function runVariants(
  input: VariantInput, handlers: VariantHandlers = {},
): Promise<VariantOutcome[]> {
  const outcomes: VariantOutcome[] = []
  for (const styleId of input.styleIds) {
    if (cancelled(input.signal)) break
    const controller = new AbortController()
    const outcome = await runStyle(input, styleId, AbortSignal.any([controller.signal, input.signal]))
    // Release this style's controller; the batch keeps only the external signal.
    controller.abort()
    if (cancelled(input.signal)) break
    outcomes.push(outcome)
    handlers.onOutcome?.(outcome)
  }
  return outcomes
}
