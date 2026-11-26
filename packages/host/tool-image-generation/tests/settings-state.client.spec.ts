/** Image-service setup keeps credential input out of observable state and preserves partial writes. */
import { expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ServiceId, ServiceInput, ServiceView } from '@deepseek-ai/dsh-direct-ai/types'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ImageSettingsController, type ImageGenerationSettings, type ImageSettingsRemote } from '../src/client/state.ts'

const service: ServiceView = { id: 'image-a' as ServiceId, name: 'Image A', capability: 'image', configured: true,
  baseURL: 'https://images.example/v1', model: 'image-model' }
const input: ServiceInput = { name: service.name, baseURL: service.baseURL, model: service.model, apiKey: 'draft-key-sentinel', capability: 'image' }
function fixture(options: { partial?: boolean; failSave?: boolean; services?: ServiceView[] } = {}) {
  const value: ConfigFormSnapshot<ImageGenerationSettings> = { status: 'ready', value: { defaultServiceId: '' }, revision: 8,
    base: {}, user: {}, writable: true }
  const form: ConfigForm<ImageGenerationSettings> = { getSnapshot: () => value, subscribe: () => () => {},
    mutate: vi.fn(), set: vi.fn(), unset: vi.fn() }
  const namespace: SettingsNamespaceView = { autoGenerate: false, ns: 'image-generation', schema: {},
    value: { defaultServiceId: '' }, applies: 'live', secrets: [], revision: 9 }
  const remote: ImageSettingsRemote = {
    directAi: { catalog: vi.fn(async () => ({ ok: true as const, value: options.services ?? [service] })),
      save: vi.fn(async () => { if (options.failSave) throw new Error('unsafe secret'); return { ok: true as const, value: service } }) },
    settings: { update: vi.fn(async () => {
      if (options.partial) throw new Error('default update not confirmed')
      return { ok: true as const, value: namespace }
    }) },
  }
  const controller = new ImageSettingsController(remote, form)
  return { controller, remote, value }
}

it('saves a service once before selecting the confirmed id with its revision', async () => {
  const f = fixture()
  await f.controller.refresh()
  expect(await f.controller.save(input)).toBe(true)
  expect(f.remote.directAi.save).toHaveBeenCalledExactlyOnceWith(input)
  expect(f.remote.settings.update).toHaveBeenCalledExactlyOnceWith('image-generation', { defaultServiceId: service.id }, 8)
  expect(JSON.stringify(f.controller.state.getSnapshot())).not.toContain(input.apiKey)
  await f.controller.dispose()
})

it('retains the saved service and visibly reports a non-atomic default failure', async () => {
  const f = fixture({ partial: true, services: [] })
  await f.controller.refresh()
  expect(await f.controller.save(input)).toBe(false)
  expect(f.controller.state.getSnapshot()).toMatchObject({ error: 'partialSave', services: [service], mutation: 'idle' })
  expect(f.remote.directAi.save).toHaveBeenCalledOnce()
  await f.controller.dispose()
})

it('does not update a default when saving was not confirmed or expose transport text', async () => {
  const f = fixture({ failSave: true })
  await f.controller.refresh()
  expect(await f.controller.save(input)).toBe(false)
  expect(f.remote.settings.update).not.toHaveBeenCalled()
  expect(f.controller.state.getSnapshot().error).toBe('saveError')
  expect(JSON.stringify(f.controller.state.getSnapshot())).not.toContain('unsafe secret')
  await f.controller.dispose()
})

it('refuses stale, keyless or chat service selection and accepts explicit off', async () => {
  const f = fixture({ services: [service, { ...service, id: 'chat' as ServiceId, capability: 'chat' }] })
  await f.controller.refresh()
  expect(await f.controller.choose('missing')).toBe(false)
  expect(await f.controller.choose('chat')).toBe(false)
  expect(await f.controller.choose('')).toBe(true)
  expect(f.remote.settings.update).toHaveBeenCalledExactlyOnceWith('image-generation', { defaultServiceId: '' }, 8)
  await f.controller.dispose()
})

it('joins an outstanding write on disposal without publishing after closing', async () => {
  const f = fixture()
  await f.controller.refresh()
  const gate = Promise.withResolvers<undefined>()
  vi.mocked(f.remote.directAi.save).mockImplementationOnce(async () => { await gate.promise; return { ok: true as const, value: service } })
  const saving = f.controller.save(input)
  let disposed = false
  const disposing = f.controller.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  gate.resolve(undefined)
  expect(await saving).toBe(false)
  await disposing
  expect(f.remote.settings.update).not.toHaveBeenCalled()
})
