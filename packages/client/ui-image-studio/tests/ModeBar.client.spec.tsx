// @vitest-environment jsdom
/** Mode bar behavior: two workspace options, one selected, and a selection callback. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ModeBar, type ModeBarMode } from '../src/client/ModeBar.tsx'
import type {} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount(mode: ModeBarMode, dictionary: typeof en | typeof zh = en) {
  const onSelect = vi.fn()
  const view = render(<ModeBar mode={mode} onSelect={onSelect} t={makeTranslate(dictionary)} />)
  const rerender = (next: ModeBarMode): void => {
    view.rerender(<ModeBar mode={next} onSelect={onSelect} t={makeTranslate(dictionary)} />)
  }
  return { onSelect, rerender }
}

describe('mode bar', () => {
  it('renders the conversation and image-generation options with their state', () => {
    mount('chat')
    expect(screen.getByRole('group', { name: en.modeLabel })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chat }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.imageStudio }).getAttribute('aria-pressed')).toBe('false')
  })

  it('reports only the other option and follows the owner mode', () => {
    const view = mount('chat')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.imageStudio }))
    expect(view.onSelect).toHaveBeenCalledExactlyOnceWith('image')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.chat }))
    expect(view.onSelect).toHaveBeenCalledOnce()
    view.rerender('image')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.imageStudio }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chat }).getAttribute('aria-pressed')).toBe('false')
  })

  it('uses the localized labels of the active dictionary', () => {
    mount('image', zh)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.imageStudio }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.chat }).getAttribute('aria-pressed')).toBe('false')
  })
})
