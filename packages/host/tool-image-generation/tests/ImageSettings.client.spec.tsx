// @vitest-environment jsdom
/** Configuration and generated images use injected data; no credential or gallery state is re-created in presentation. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import { ImageSettings, type ImageSettingsProps } from '../src/client/ImageSettings.tsx'
import { en } from '../src/client/locales.ts'
import type { ImageGenerationSettings, ImageSettingsState } from '../src/client/state.ts'
import type {} from '../src/client/index.ts'

function mount(overrides: { state?: Partial<ImageSettingsState>; settings?: Partial<ConfigFormSnapshot<ImageGenerationSettings>> } = {}) {
  const state: ImageSettingsState = { phase: 'ready', services: [], mutation: 'idle', ...overrides.state }
  const settings: ConfigFormSnapshot<ImageGenerationSettings> = { status: 'ready', value: { defaultServiceId: '' },
    base: {}, user: {}, revision: 5, writable: true, ...overrides.settings }
  const save = vi.fn<ImageSettingsProps['save']>(async () => true)
  const choose = vi.fn<ImageSettingsProps['choose']>(async () => true)
  const refresh = vi.fn(async () => {})
  const props: ImageSettingsProps = { ...({} as GlobalStandardProps), t: makeTranslate(en),
    useState: select => select(state), useSettings: select => select(settings), save, choose, refresh }
  return { ...render(<ImageSettings {...props} />), props, save, choose, refresh }
}

afterEach(() =>{  cleanup() })

it('prefills the gateway image model without changing the write-only key', () => {
  const f = mount()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'draft-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'CrazyToken / aiyoyoo' }))
  expect(screen.getByLabelText<HTMLInputElement>('API base URL').value).toBe('https://www.aiyoyoo.com/v1')
  expect(screen.getByLabelText<HTMLInputElement>('Image model ID').value).toBe('gpt-image-2')
  expect(screen.getByLabelText<HTMLInputElement>('API key').value).toBe('draft-key')
  expect(f.save).not.toHaveBeenCalled()
})

it('requires explicit credentials and clears them before awaiting save', async () => {
  const f = mount()
  fireEvent.click(screen.getByRole('button', { name: 'CrazyToken / aiyoyoo' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save and use for conversation images' }))
  expect(f.save).not.toHaveBeenCalled()
  const gate = Promise.withResolvers<boolean>()
  f.save.mockImplementationOnce(async () => gate.promise)
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'write-only-sentinel' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save and use for conversation images' }))
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ name: 'CrazyToken / aiyoyoo', baseURL: 'https://www.aiyoyoo.com/v1',
    model: 'gpt-image-2', capability: 'image', apiKey: 'write-only-sentinel' })
  expect(screen.getByLabelText<HTMLInputElement>('API key').value).toBe('')
  await act(async () => { gate.resolve(true); await gate.promise })
})

it('shows a missing configured default without falling back to the first service', () => {
  const f = mount({ settings: { value: { defaultServiceId: 'missing' } }, state: { services: [{
    id: 'image' as ServiceId, name: 'Studio', baseURL: 'https://images.example/v1', model: 'image-model', capability: 'image', configured: true,
  }] } })
  expect(screen.getByRole('alert').textContent).toContain(en.missing)
  expect(f.choose).not.toHaveBeenCalled()
})

it('requires readback after a partial save and preserves a reload action', async () => {
  const f = mount({ state: { error: 'partialSave' } })
  expect(screen.getByRole('alert').textContent).toBe(en.partialSave)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await waitFor(() =>{  expect(f.refresh).toHaveBeenCalledOnce() })
})

it('exposes loading and read-only states without enabling generation configuration', () => {
  const f = mount({ state: { phase: 'loading' }, settings: { writable: false } })
  expect(screen.getByRole('status', { name: 'Loading image services' })).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
  expect(f.save).not.toHaveBeenCalled()
})
