/**
 * Naming, media-type, and directory-containment rules shared by the Remote
 * operations and the byte route.
 * @module @deepseek-ai/dsh-workspace-assets/src/library
 */

import { resolve, sep } from 'node:path'
import type { WorkspaceAssetCategory } from './types.ts'

/** Folder name of each category below the configured asset folder. */
export const CATEGORY_DIRECTORIES: Readonly<Record<WorkspaceAssetCategory, string>> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
}

/** Every category, in the order `list` emits them. */
export const CATEGORIES: readonly WorkspaceAssetCategory[] = ['character', 'scene', 'prop']

/** Image media type each stored extension serves. */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** Extension written for each accepted upload media type. */
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
}

/** Characters a stored file name may never contain: separators, controls, and Windows-reserved punctuation. */
const FORBIDDEN_CHARACTER = /[\u0000-\u001f\u007f/\\:*?"<>|]/u

/** The same set, global, so one replacement removes every occurrence. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f/\\:*?"<>|]/gu

/** Leading and trailing dots and spaces, which a stored file name may never start or end with. */
const EDGE_DOTS_AND_SPACES = /^[.\s]+|[.\s]+$/gu

/** Longest file stem kept from a title; the remainder of a long title is dropped. */
const MAX_STEM_LENGTH = 120

/**
 * Whether a value names one of the three asset categories.
 * @param value - candidate wire or configuration value.
 * @returns true for `character`, `scene`, or `prop`.
 */
export function isCategory(value: string): value is WorkspaceAssetCategory {
  return value === 'character' || value === 'scene' || value === 'prop'
}

/**
 * Whether a configured folder name is exactly one usable path segment.
 * @param value - candidate folder name.
 * @returns true for a non-empty segment that is neither `.` nor `..` and holds no forbidden character.
 */
export function isFolderName(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !FORBIDDEN_CHARACTER.test(value)
}

/**
 * Media type served for a stored file name.
 * @param name - file name, extension included.
 * @returns the image media type, or undefined for a name the library never stores.
 */
export function mimeForName(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return EXTENSION_MIME[name.slice(dot)]
}

/**
 * Extension written for an upload's declared media type.
 * @param mime - declared media type.
 * @returns `.png`, `.jpg`, or `.webp`, or undefined for an unsupported type.
 */
export function extensionForMime(mime: string): string | undefined {
  return MIME_EXTENSION[mime]
}

/**
 * Turn a display title into the file stem that represents it.
 * A title made only of removed characters falls back to `asset`, so every title yields one usable name.
 * @param title - user-supplied display title.
 * @returns a non-empty stem without separators, control characters, or edge dots and spaces.
 */
export function assetFileStem(title: string): string {
  const cleaned = title
    .replace(FORBIDDEN_CHARACTERS, '')
    .slice(0, MAX_STEM_LENGTH)
    .replace(EDGE_DOTS_AND_SPACES, '')
  return cleaned === '' ? 'asset' : cleaned
}

/**
 * Whether a requested file name is one this library could have written.
 * @param name - candidate file name, extension included.
 * @returns true when the extension is served and the stem is already in its written form.
 */
export function isAssetFileName(name: string): boolean {
  if (name === '' || mimeForName(name) === undefined) return false
  if (FORBIDDEN_CHARACTER.test(name)) return false
  return assetFileStem(name.slice(0, name.lastIndexOf('.'))) === name.slice(0, name.lastIndexOf('.'))
}

/**
 * Resolve one path below a workspace directory, refusing any escape.
 * @param root - absolute workspace directory.
 * @param segments - relative segments in order; at least one is required.
 * @returns the absolute path when it stays below the root, otherwise undefined.
 */
export function containedPath(root: string, segments: readonly string[]): string | undefined {
  if (segments.length === 0) return undefined
  const base = resolve(root)
  const target = resolve(base, ...segments)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return target.startsWith(prefix) ? target : undefined
}

/**
 * Read the filesystem error code carried by a caught value.
 * @param error - caught value.
 * @returns the `code` string when the value carries one.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code: unknown = error.code
  return typeof code === 'string' ? code : undefined
}
