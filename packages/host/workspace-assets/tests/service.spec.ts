/** Real Connection composition over temporary workspace directories pins storage, listing, the byte route and teardown. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { expect, it, onTestFinished } from 'vitest'
import WorkspaceAssets from '../src/index.ts'
import { configSchema, type Config } from '../src/config.ts'
import type { WorkspaceAssetCategory } from '../src/types.ts'

/** One workspace record the asset library can bind to; membership and titles are not under test here. */
class StubWorkspace implements Workspace {
  readonly createdAt = '1970-01-01T00:00:00.000Z'
  readonly updatedAt = '1970-01-01T00:00:00.000Z'
  readonly sessionIds: Workspace['sessionIds'] = []

  constructor(readonly id: WorkspaceId, readonly path: string, readonly title: string) {}

  getSessionHeaders(): ReturnType<Workspace['getSessionHeaders']> {
    return []
  }

  async setTitle(_title: string): Promise<void> {}

  async attachSession(_sessionId: Workspace['sessionIds'][number]): Promise<void> {}

  async insertSessionBefore(
    _sessionId: Workspace['sessionIds'][number], _beforeSessionId?: Workspace['sessionIds'][number],
  ): Promise<void> {}

  async detachSession(_sessionId: Workspace['sessionIds'][number]): Promise<void> {}

  async status(): Promise<'ok' | 'missing-dir'> {
    return 'ok'
  }
}

/** The registry seat the asset library reads; the real registry owns durability and is covered by dsh-workspace. */
class StubWorkspaceRegistry extends Service {
  constructor(ctx: Context, private readonly workspaces: readonly Workspace[]) {
    super(ctx, 'workspaceRegistry')
  }

  list(): Workspace[] {
    return [...this.workspaces]
  }

  get(id: WorkspaceId): Workspace | undefined {
    return this.workspaces.find(workspace => workspace.id === id)
  }
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const pngBase64 = png.toString('base64')

/** Compose the real Connection plugin, a registry seat, and the asset service over a temporary workspace pair. */
async function composed(config: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-assets-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-workspace-assets-')) {
      throw new Error('Unexpected fixture cleanup path')
    }
    await rm(root, { recursive: true, force: true })
  })
  new StubWorkspaceRegistry(ctx, [
    new StubWorkspace(WorkspaceId('w-first'), first, 'First'),
    new StubWorkspace(WorkspaceId('w-second'), second, 'Second'),
  ])
  await ctx.plugin(Connection)
  const fiber = ctx.plugin(WorkspaceAssets, configSchema(config))
  await fiber.await()
  const fetcher = ctx.connection.createSharedFetchHandler('/api')
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  return { ctx, root, first, second, assets: ctx.workspaceAssets, fetcher, peer, fiber }
}

/** Store one PNG under a title and category of the first workspace. */
async function store(
  assets: Awaited<ReturnType<typeof composed>>['assets'], category: WorkspaceAssetCategory, title: string,
  data = pngBase64, mime = 'image/png',
) {
  return assets.save({ workspaceId: 'w-first', category, title, data, mime })
}

it('writes one image per category folder and appends a sequence on a taken name', async () => {
  const { first, assets } = await composed()
  const asset = await store(assets, 'character', 'Hero')
  const path = join(first, '资产库', '角色', 'Hero.png')
  expect(asset).toMatchObject({ name: 'Hero.png', title: 'Hero', category: 'character', bytes: png.byteLength })
  expect(asset.url).toBe('api/workspace-assets/file?id=Hero.png&workspace=w-first&category=character')
  expect(asset.modifiedAt).toBeGreaterThan(0)
  expect(existsSync(path)).toBe(true)
  expect(await readFile(path)).toEqual(png)
  const duplicate = await store(assets, 'character', 'Hero')
  expect(duplicate.name).toBe('Hero-2.png')
  expect(duplicate.title).toBe('Hero-2')
  expect(existsSync(join(first, '资产库', '角色', 'Hero-2.png'))).toBe(true)
  expect((await assets.list('w-first')).map(entry => entry.name).sort()).toEqual(['Hero-2.png', 'Hero.png'])
  if (process.platform !== 'win32') {
    expect((await stat(join(first, '资产库', '角色'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
})

it('uses the configured folder name and keeps every category inside it', async () => {
  const { first, assets } = await composed({ folderName: 'assets' })
  await store(assets, 'scene', 'Stairs')
  expect(existsSync(join(first, 'assets', '场景', 'Stairs.png'))).toBe(true)
  expect(existsSync(join(first, '资产库'))).toBe(false)
  expect((await assets.list('w-first')).map(entry => entry.url)).toEqual([
    'api/workspace-assets/file?id=Stairs.png&workspace=w-first&category=scene',
  ])
})

it('lists only stored images, skips links and other files, and reports an absent folder as empty', async () => {
  const { first, second, assets } = await composed()
  await store(assets, 'character', 'Hero')
  await store(assets, 'scene', 'Stairs')
  await store(assets, 'prop', 'Sword', pngBase64, 'image/webp')
  await writeFile(join(first, '资产库', '角色', 'notes.txt'), 'not an image')
  await mkdir(join(first, '资产库', '角色', 'nested'))
  await symlink(join(first, '资产库', '角色', 'nested'), join(first, '资产库', '角色', 'linked.png'),
    process.platform === 'win32' ? 'junction' : 'dir')
  expect((await assets.list('w-first')).map(entry => `${entry.category}/${entry.name}`)).toEqual([
    'character/Hero.png', 'scene/Stairs.png', 'prop/Sword.webp',
  ])
  expect(await assets.list('w-second')).toEqual([])
  expect(existsSync(join(second, '资产库'))).toBe(false)
})

it('removes one stored image and answers false when no regular file holds the name', async () => {
  const { first, assets } = await composed()
  const asset = await store(assets, 'character', 'Hero')
  expect(await assets.removeAsset('w-first', 'character', asset.name)).toBe(true)
  expect(existsSync(join(first, '资产库', '角色', 'Hero.png'))).toBe(false)
  expect(await assets.removeAsset('w-first', 'character', asset.name)).toBe(false)
  // A file of another workspace never answers for this one.
  await store(assets, 'character', 'Hero')
  expect(await assets.removeAsset('w-second', 'character', asset.name)).toBe(false)
  expect((await assets.list('w-first')).map(entry => entry.name)).toEqual(['Hero.png'])
})

it('refuses malformed uploads, unknown workspaces, unknown categories and traversal names', async () => {
  const { root, first, assets } = await composed({ maxAssetBytes: png.byteLength })
  const base = { workspaceId: 'w-first', category: 'character' as const, title: 'Hero', mime: 'image/png' }
  for (const data of ['AAAA!', 'data:image/png;base64,AAAA', 'AAA', 'AB==', '']) {
    await expect(assets.save({ ...base, data })).rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
  }
  await expect(assets.save({ ...base, data: pngBase64, mime: 'image/gif' }))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
  await expect(assets.save({ ...base, data: Buffer.concat([png, Buffer.from([0])]).toString('base64') }))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_TOO_LARGE' })
  await expect(assets.save({ ...base, data: pngBase64, workspaceId: 'w-missing' }))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_NOT_FOUND' })
  await expect(assets.list('w-missing')).rejects.toMatchObject({ code: 'WORKSPACE_ASSET_NOT_FOUND' })
  await expect(assets.save({ ...base, data: pngBase64, category: 'vehicle' as WorkspaceAssetCategory }))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
  await expect(assets.removeAsset('w-first', 'vehicle' as WorkspaceAssetCategory, 'Hero.png'))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
  expect(await assets.list('w-first')).toEqual([])
  // A traversal title is sanitized into a contained file name instead of reaching outside the workspace.
  const escaped = await assets.save({ ...base, data: pngBase64, title: '../../escape' })
  expect(escaped.name).toBe('escape.png')
  expect(existsSync(join(first, '资产库', '角色', 'escape.png'))).toBe(true)
  expect(existsSync(join(root, 'escape.png'))).toBe(false)
  await expect(assets.removeAsset('w-first', 'character', '../escape.png'))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
  await expect(assets.removeAsset('w-first', 'character', 'escape'))
    .rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
  await expect(assets.removeAsset('w-first', 'character', escaped.name)).resolves.toBe(true)
})

it('serves stored bytes over the exact route and answers 404 for every other identifier', async () => {
  const { root, first, assets, fetcher, peer, fiber } = await composed()
  const asset = await store(assets, 'character', 'Hero')
  const url = `http://host/${asset.url}`
  const response = await fetcher.fetch(new Request(url), peer)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-disposition')).toBe('inline')
  expect(response.headers.get('content-length')).toBe(String(png.byteLength))
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  const head = await fetcher.fetch(new Request(url, { method: 'HEAD' }), peer)
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  const webp = await store(assets, 'scene', 'Stairs', pngBase64, 'image/webp')
  const webpResponse = await fetcher.fetch(new Request(`http://host/${webp.url}`), peer)
  expect(webpResponse.status).toBe(200)
  expect(webpResponse.headers.get('content-type')).toBe('image/webp')
  for (const query of [
    `id=${asset.name}&workspace=w-missing&category=character`,
    `id=${asset.name}&workspace=w-first&category=vehicle`,
    'id=missing.png&workspace=w-first&category=character',
    'id=..%2F..%2Fescape.png&workspace=w-first&category=character',
    `id=${asset.name}&workspace=w-first`,
  ]) {
    const miss = await fetcher.fetch(new Request(`http://host/api/workspace-assets/file?${query}`), peer)
    expect(miss.status).toBe(404)
    expect(await miss.text()).not.toContain('资产库')
  }
  // A link inside the asset folder is never followed.
  await symlink(join(root, 'first'), join(first, '资产库', '角色', 'linked.png'),
    process.platform === 'win32' ? 'junction' : 'dir')
  const linked = await fetcher.fetch(
    new Request('http://host/api/workspace-assets/file?id=linked.png&workspace=w-first&category=character'), peer,
  )
  expect(linked.status).toBe(404)
  await fiber.dispose()
  expect((await fetcher.fetch(new Request(url), peer)).status).toBe(404)
})

it('reports registered workspaces in registry order', async () => {
  const { first, second, assets } = await composed()
  expect(await assets.workspaces()).toEqual([
    { id: 'w-first', title: 'First', path: first },
    { id: 'w-second', title: 'Second', path: second },
  ])
})

it('treats a non-directory category folder as empty, refuses to write through it, and skips links', async () => {
  const { first, assets, fetcher, peer } = await composed({ maxAssetBytes: png.byteLength })
  await mkdir(join(first, '资产库'))
  await writeFile(join(first, '资产库', '角色'), 'not a directory')
  expect(await assets.list('w-first')).toEqual([])
  await expect(store(assets, 'character', 'Hero')).rejects.toMatchObject({ code: 'WORKSPACE_ASSET_STORAGE_FAILED' })
  await rm(join(first, '资产库', '角色'), { force: true })
  const asset = await store(assets, 'character', 'Hero')
  await writeFile(join(first, '资产库', '角色', 'Big.png'), Buffer.concat([png, Buffer.from([0])]))
  const oversize = await fetcher.fetch(
    new Request('http://host/api/workspace-assets/file?id=Big.png&workspace=w-first&category=character'), peer,
  )
  expect(oversize.status).toBe(404)
  await symlink(join(first, '资产库', '角色'), join(first, '资产库', '角色', 'linked.png'),
    process.platform === 'win32' ? 'junction' : 'dir')
  expect(await assets.removeAsset('w-first', 'character', 'linked.png')).toBe(false)
  expect(await assets.removeAsset('w-first', 'character', asset.name)).toBe(true)
})

it('refuses the bounded number of duplicate names and a folder name that is not one segment', async () => {
  const { first, assets } = await composed()
  await mkdir(join(first, '资产库', '角色'), { recursive: true })
  for (let index = 1; index <= 20; index += 1) {
    await writeFile(join(first, '资产库', '角色', index === 1 ? 'Hero.png' : `Hero-${index}.png`), png)
  }
  await expect(store(assets, 'character', 'Hero')).rejects.toMatchObject({ code: 'WORKSPACE_ASSET_STORAGE_FAILED' })
  await expect(composed({ folderName: '../outside' })).rejects.toMatchObject({ code: 'WORKSPACE_ASSET_INVALID_INPUT' })
})
