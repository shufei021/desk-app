/**
 * Generation parameters recovered from a retained request for the result card.
 *
 * The composer owns the offered qualities and counts; this module only
 * recognizes the explicit `size`, `quality` and `n` fields a saved request may
 * carry, without trusting their JSON types.
 */

/** Generation parameters recovered from a retained request for the result card. */
export interface ImageParamFacts {
  /** `WxH` size the request asked for. */
  readonly size?: string
  /** Provider quality value the request asked for. */
  readonly quality?: 'low' | 'medium' | 'high'
  /** Images the request asked for. */
  readonly count?: number
}

/** Provider quality values the composer offers. */
const IMAGE_QUALITY_VALUES: readonly string[] = ['low', 'medium', 'high']

/** Greatest number of images one request may ask for. */
const IMAGE_COUNT_MAX = 4

/** Read one JSON object without trusting its field types. */
function objectOf(value: unknown): object | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Read a member of a narrowed JSON object. */
function field(record: object, key: string): unknown {
  return key in record ? Reflect.get(record, key) : undefined
}

/**
 * Recover displayable generation parameters from a retained request's JSON.
 * @param parametersJson - the request's explicit provider parameters, when present.
 * @returns the recognized size, quality and count; undefined when none is present.
 */
export function imageParamFacts(parametersJson?: string): ImageParamFacts | undefined {
  if (parametersJson === undefined || parametersJson.trim() === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(parametersJson) } catch (_invalidJson) { return undefined }
  const record = objectOf(parsed)
  if (record === undefined) return undefined
  const size = field(record, 'size')
  const quality = field(record, 'quality')
  const count = field(record, 'n')
  const facts: { size?: string; quality?: 'low' | 'medium' | 'high'; count?: number } = {}
  if (typeof size === 'string' && /^\d{1,5}x\d{1,5}$/.test(size)) facts.size = size
  if (typeof quality === 'string' && IMAGE_QUALITY_VALUES.includes(quality)) facts.quality = quality as 'low' | 'medium' | 'high'
  if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= IMAGE_COUNT_MAX) facts.count = count
  return facts.size === undefined && facts.quality === undefined && facts.count === undefined ? undefined : facts
}
