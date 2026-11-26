/** Naming, media-type, and containment rules that every read, write, and route answer depends on. */
import { join, parse, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  CATEGORIES, CATEGORY_DIRECTORIES, assetFileStem, containedPath, errorCode, extensionForMime,
  isAssetFileName, isCategory, isFolderName, mimeForName,
} from '../src/library.ts'

it('maps the three categories onto their fixed folders', () => {
  expect(CATEGORIES).toEqual(['character', 'scene', 'prop'])
  expect(CATEGORY_DIRECTORIES).toEqual({ character: '角色', scene: '场景', prop: '道具' })
  expect(isCategory('character')).toBe(true)
  expect(isCategory('vehicle')).toBe(false)
})

it('accepts only one usable path segment as the asset folder name', () => {
  expect(isFolderName('资产库')).toBe(true)
  expect(isFolderName('my assets')).toBe(true)
  expect(isFolderName('')).toBe(false)
  expect(isFolderName('.')).toBe(false)
  expect(isFolderName('..')).toBe(false)
  expect(isFolderName('资产/库')).toBe(false)
  expect(isFolderName('资产\u0000库')).toBe(false)
})

it('serves and writes only the supported image media types', () => {
  expect(mimeForName('Hero.png')).toBe('image/png')
  expect(mimeForName('Hero.JPG')).toBeUndefined()
  expect(mimeForName('Hero.jpeg')).toBe('image/jpeg')
  expect(mimeForName('Hero.webp')).toBe('image/webp')
  expect(mimeForName('Hero.gif')).toBeUndefined()
  expect(mimeForName('Hero')).toBeUndefined()
  expect(mimeForName('.png')).toBeUndefined()
  expect(extensionForMime('image/png')).toBe('.png')
  expect(extensionForMime('image/jpeg')).toBe('.jpg')
  expect(extensionForMime('image/webp')).toBe('.webp')
  expect(extensionForMime('image/gif')).toBeUndefined()
})

it('sanitizes a title into one stored file stem', () => {
  expect(assetFileStem('Hero')).toBe('Hero')
  expect(assetFileStem('  Hero  ')).toBe('Hero')
  expect(assetFileStem('../escape')).toBe('escape')
  expect(assetFileStem('a/b\\c.png')).toBe('abc.png')
  expect(assetFileStem('bad:name*?')).toBe('badname')
  expect(assetFileStem('...')).toBe('asset')
  expect(assetFileStem('')).toBe('asset')
  expect(assetFileStem('x'.repeat(400))).toHaveLength(120)
})

it('accepts only file names the library itself writes', () => {
  expect(isAssetFileName('Hero.png')).toBe(true)
  expect(isAssetFileName('Hero-2.webp')).toBe(true)
  expect(isAssetFileName('asset.png')).toBe(true)
  expect(isAssetFileName('Hero')).toBe(false)
  expect(isAssetFileName('Hero.gif')).toBe(false)
  expect(isAssetFileName('')).toBe(false)
  expect(isAssetFileName('.hidden.png')).toBe(false)
  expect(isAssetFileName('../Hero.png')).toBe(false)
  expect(isAssetFileName('Hero .png')).toBe(false)
  expect(isAssetFileName(`${'x'.repeat(200)}.png`)).toBe(false)
})

it('resolves one path below a root and refuses every escape', () => {
  const root = resolve('workspace-root')
  expect(containedPath(root, ['资产库', '角色', 'Hero.png'])).toBe(join(root, '资产库', '角色', 'Hero.png'))
  // A filesystem root already ends with the separator, so the prefix needs no second one.
  const filesystemRoot = parse(root).root
  expect(containedPath(filesystemRoot, ['Hero.png'])).toBe(join(filesystemRoot, 'Hero.png'))
  expect(containedPath(root, [])).toBeUndefined()
  expect(containedPath(root, ['..', 'outside.png'])).toBeUndefined()
  expect(containedPath(root, ['资产库', '..', '..', 'outside.png'])).toBeUndefined()
})

it('reads a filesystem error code without trusting the caught value', () => {
  expect(errorCode(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('ENOENT')
  expect(errorCode({ code: 7 })).toBeUndefined()
  expect(errorCode(new Error('plain'))).toBeUndefined()
  expect(errorCode('not an error')).toBeUndefined()
  expect(errorCode(null)).toBeUndefined()
})
