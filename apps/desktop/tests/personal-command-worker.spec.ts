/** Personal runtime command workers reject shared command management before reaching OS mutations. */
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: (path: string) => path.endsWith('personal-build.json'),
}))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: state.spawn,
}))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it.each(['inspect', 'install', 'remove'])('rejects personal %s before a subprocess or file command can run', async (operation) => {
  const argv = process.argv
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    process.argv = [process.execPath, 'command-manager.js', operation, 'a'.repeat(64)]
    vi.resetModules()
    await import('../src/command-manager-entry.ts')
    expect(state.spawn).not.toHaveBeenCalled()
    expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toEqual({
      ok: false, code: 'EUNSUPPORTED', message: 'Personal builds do not manage the shared dsh command.',
    })
  } finally { process.argv = argv }
})
