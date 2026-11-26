/** Pure directory and service facets; annotations never select a protocol or provider route. */
import type { DirectoryGroup, DirectoryModel, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'

/** One exact-value filter option; descriptions remain provider-authored text. */
export interface FacetOption { id: string; label: string; description?: string }

type GroupAnnotation = Pick<DirectoryModel, 'platform' | 'groupId' | 'groupName'>

/**
 * Identify a group independently of its display name, including manually entered labels.
 * @param item - provider annotations or saved local labels.
 * @returns an exact facet identity, or undefined for an unlabelled group.
 */
export function groupKey(item: GroupAnnotation): string | undefined {
  if (item.groupId !== undefined) return JSON.stringify([item.groupId])
  return item.groupName ? JSON.stringify([item.platform, item.groupName]) : undefined
}

/**
 * Derive exact platform choices without inferring a model's vendor.
 * @param items - current directory rows or saved service labels.
 * @returns first-seen, non-empty platform values.
 */
export function platformOptions(items: readonly { platform?: string }[]): FacetOption[] {
  const values = new Set(items.map(item => item.platform).filter((value): value is string => !!value))
  return [...values].map(value => ({ id: value, label: value }))
}

/**
 * Derive group choices from the current data, preserving distinct identities with the same name.
 * @param items - model or service annotations.
 * @param groups - optional provider group descriptions.
 * @returns exact group identities in first-seen order.
 */
export function groupOptions(items: readonly GroupAnnotation[], groups: readonly DirectoryGroup[] = []): FacetOption[] {
  const options = new Map<string, FacetOption>()
  for (const group of groups) {
    const id = JSON.stringify([group.id])
    options.set(id, { id, label: group.name, description: group.description })
  }
  for (const item of items) {
    const id = groupKey(item)
    if (id !== undefined && !options.has(id)) options.set(id, { id, label: item.groupName || String(item.groupId) })
  }
  return [...options.values()]
}

/**
 * Convert optional saved labels to the directory facet representation.
 * @param service - saved metadata, never credentials.
 * @returns annotations whose platform remains the original value.
 */
export function serviceAnnotations(service: ServiceView): GroupAnnotation {
  return { platform: service.platform ?? '', ...service.groupId === undefined ? {} : { groupId: service.groupId },
    ...service.groupName === undefined ? {} : { groupName: service.groupName } }
}

/**
 * Normalize an allowed API base URL for credential reuse comparisons.
 * @param value - user-entered or saved base URL.
 * @returns a canonical URL without trailing slashes, or undefined for an invalid address.
 */
export function normalizedBaseURL(value: string): string | undefined {
  let url: URL
  try { url = new URL(value.trim()) } catch (_invalidURL) { return undefined }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) return undefined
  return url.href.replace(/\/+$/, '')
}
