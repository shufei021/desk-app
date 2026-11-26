/** New display annotations keep v1 service records readable without exposing private credential pointers. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import { expect, it, onTestFinished } from 'vitest'
import { directDomain } from '../src/storage.ts'
import type { ServiceId } from '../src/types.ts'

it('reads a v1 record in v2 and stamps only a subsequently updated record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-directory-storage-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = 's-00000000-0000-4000-8000-000000000001' as ServiceId
  const path = join(root, 'direct_ai', 'services', `${id}.json`)
  await mkdir(join(root, 'direct_ai', 'services'), { recursive: true })
  const record = { id, name: 'Older service', capability: 'chat', baseURL: 'https://provider.example/v1', model: 'older-model',
    credentialId: 'c-00000000-0000-4000-8000-000000000002' }
  const original = JSON.stringify({ version: 1, record })
  await writeFile(path, original, 'utf8')
  await ctx.plugin(Storage)
  await ctx.plugin(Json, { root })
  await ctx.plugin(Domain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(directDomain)
  ctx.effect(() => () => domain.close())
  expect(domain.table('services').get(id)).toEqual(record)
  expect(await readFile(path, 'utf8')).toBe(original)
  await domain.table('services').put(id, { ...record, capability: 'chat', platform: 'openai', groupId: 27, groupName: 'Existing group' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 2, record: { platform: 'openai', groupId: 27 } })
})
