// @vitest-environment jsdom
/** Directory presentation uses explicit rows and isolated, local filters. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelDirectory } from '@deepseek-ai/dsh-direct-ai/types'
import { ModelBrowser } from '../src/client/ModelBrowser.tsx'
import type { DirectoryState } from '@deepseek-ai/dsh-client-direct-ai-client'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const value: ModelDirectory = {
  source: 'aiyoyoo-public', fetchedAt: 1,
  groups: [
    { id: 1, name: 'Shared name', platform: 'anthropic', description: 'first route' },
    { id: 2, name: 'Shared name', platform: 'openai', description: 'second route' },
  ],
  models: [
    { id: 'compact-model', platform: 'anthropic', groupId: 1, groupName: 'Shared name' },
    { id: 'compact-model', platform: 'openai', groupId: 2, groupName: 'Shared name' },
    { id: 'Café-image', platform: 'gemini' },
  ],
}
function mount(directory: DirectoryState = { phase: 'ready', value }) {
  const onSelect = vi.fn()
  const onRetry = vi.fn()
  const props = { t: makeTranslate(en), selectedModel: '', selectedGroupId: undefined, onSelect, onRetry }
  const view = render(<ModelBrowser {...props} directory={directory} />)
  return { ...view, onSelect, onRetry, update: (next: DirectoryState) => { view.rerender(<ModelBrowser {...props} directory={next} />) } }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Model directory browser', () => {
  it('searches all terms with normalization and word-start fuzzy matching', () => {
    mount()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cpt anthropic' } })
    expect(screen.getAllByText('compact-model')).toHaveLength(1)
    expect(screen.queryByText('Café-image')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ＣＡＦＥ' } })
    expect(screen.getByText('Café-image')).toBeTruthy()
    expect(screen.queryByText('compact-model')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } })
    expect(screen.getByText(en.noMatchingModels)).toBeTruthy()
  })

  it('filters exact original platform labels and keeps same-name groups distinct', () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Platform: All' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'anthropic' }))
    expect(screen.getAllByText('compact-model')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /compact-model/ }))
    expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(value.models[0])
    fireEvent.click(screen.getByRole('button', { name: 'Platform: anthropic' }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.all }))
    fireEvent.click(screen.getByRole('button', { name: 'Group: All' }))
    const groups = screen.getAllByRole('menuitem', { name: /Shared name/ })
    expect(groups).toHaveLength(2)
    fireEvent.click(groups[1]!)
    expect(screen.getAllByText('compact-model')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /compact-model/ }))
    expect(view.onSelect).toHaveBeenLastCalledWith(value.models[1])
  })

  it('distinguishes idle, loading, error with retry, and empty directory states', () => {
    const view = mount({ phase: 'idle', value: undefined })
    expect(screen.getByText(en.directoryIdle)).toBeTruthy()
    view.update({ phase: 'loading', value: undefined })
    expect(screen.getByRole('status', { name: en.directoryLoading })).toBeTruthy()
    view.update({ phase: 'error', value: undefined, error: 'directoryError', errorCode: 'DIRECT_AI_HTTP_FAILED' })
    expect(screen.getByRole('alert').textContent).toContain(en.directoryError)
    fireEvent.click(screen.getByRole('button', { name: en.directoryRetry }))
    expect(view.onRetry).toHaveBeenCalledOnce()
    view.update({ phase: 'ready', value: { ...value, models: [], groups: [] } })
    expect(screen.getByText(en.directoryEmpty)).toBeTruthy()
  })

  it('states public versus provider scope and never treats platform labels as model capabilities', () => {
    const view = mount()
    expect(screen.getByText(en.publicDirectoryNotice)).toBeTruthy()
    expect(screen.getByText(en.groupAnnotationNotice)).toBeTruthy()
    view.update({ phase: 'ready', value: { ...value, source: 'provider' } })
    expect(screen.getByText(en.providerDirectoryNotice)).toBeTruthy()
    expect(screen.queryByText(en.publicDirectoryNotice)).toBeNull()
  })

  it('bounds initial rendering while keeping every additional result reachable', () => {
    mount({ phase: 'ready', value: { ...value, groups: [], models: Array.from({ length: 305 }, (_, index) => ({ id: `model-${index}`, platform: 'route' })) } })
    const list = screen.getByRole('list', { name: en.modelDirectory })
    expect(list.childElementCount).toBe(100)
    expect(within(list).queryByText('model-304')).toBeNull()
    fireEvent.click(screen.getByText('Show more models (205 remaining)'))
    expect(list.childElementCount).toBe(200)
    fireEvent.click(screen.getByText('Show more models (105 remaining)'))
    fireEvent.click(screen.getByText('Show more models (5 remaining)'))
    expect(list.childElementCount).toBe(305)
    expect(within(list).getByText('model-304')).toBeTruthy()
  })
})
