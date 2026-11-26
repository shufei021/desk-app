/** Prompt-preset composition: the user's description and the fixed model template. */
import { describe, expect, it } from 'vitest'
import { PROMPT_TEMPLATES, composePrompt } from '../src/client/prompt-presets.ts'

const characterTemplate = PROMPT_TEMPLATES.characterTurnaround
const sceneTemplate = PROMPT_TEMPLATES.sceneMultiView

describe('composePrompt', () => {
  it('returns the trimmed description unchanged for the free preset', () => {
    expect(composePrompt('none', '  a red fox in snow  ')).toBe('a red fox in snow')
    expect(composePrompt('none', ' \n\t ')).toBe('')
  })

  it('places the description before the template with one blank line between them', () => {
    const composed = composePrompt('characterTurnaround', '  the same character  ')
    expect(composed).toBe(`the same character\n\n${characterTemplate}`)
    expect(composed.startsWith('the same character\n\n')).toBe(true)
    expect(composed).toContain('正交')
  })

  it('returns only the template when the description is empty or whitespace', () => {
    expect(composePrompt('sceneMultiView', '')).toBe(sceneTemplate)
    expect(composePrompt('sceneMultiView', '  \n\t ')).toBe(sceneTemplate)
    expect(sceneTemplate).toContain('2×2')
  })

  it('keeps each preset template distinct and free of leading whitespace', () => {
    expect(characterTemplate).not.toBe(sceneTemplate)
    for (const template of Object.values(PROMPT_TEMPLATES)) {
      expect(template.trim()).toBe(template)
    }
  })
})
