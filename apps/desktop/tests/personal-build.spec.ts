/** Personal identity is embedded in the package, never inferred from a shell flag. */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { initializePersonalDesktop, isPersonalBuildManifest } from '../src/personal-build.ts'
import { personalDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { parseDesktopPackageInvocation } from '../scripts/package-target.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { AppInfo, Packager } from 'app-builder-lib'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const target = { platform: 'win32', arch: 'x64' } as const

describe('personal Desktop package', () => {
  it('requires the explicit Windows x64 unsigned invocation', () => {
    expect(parseDesktopPackageInvocation(['win-x64', '--personal', '--unsigned'], 'win32', 'x64')).toMatchObject({ personal: true, unsigned: true })
    expect(parseDesktopPackageInvocation(['win-x64', '--unsigned'], 'win32', 'x64').personal).toBe(false)
    for (const args of [['win-x64', '--personal'], ['win-x64', '--personal', '--unsigned', '--prepare-only']]) {
      expect(() => parseDesktopPackageInvocation(args, 'win32', 'x64')).toThrow('--personal requires')
    }
    expect(() => parseDesktopPackageInvocation(['mac-x64', '--personal', '--unsigned'], 'darwin', 'x64')).toThrow('--personal requires')
  })

  it('retains only build-tool and proxy inputs without reading presets or credentials', () => {
    const parent = { PATH: 'tools', HTTPS_PROXY: 'http://proxy.example:8080', PYTHON: 'python.exe',
      DSH_PACKAGING_PRESET: 'production', DSH_PACKAGING_CONFIG_DIR: 'must-not-read', DSH_DESKTOP_APP_ID: 'official',
      DSH_HOME: 'official-home', DSH_AGENTS_HOME: 'official-agents', DSH_DESKTOP_PERSONAL: '0',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'invalid', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'sentinel',
      APPLE_ID: 'sentinel', CSC_LINK: 'sentinel', DOWNLOAD_PROD_COS_SECRET_KEY: 'sentinel',
      DEEPSEEK_API_KEY: 'sentinel', OPENAI_API_KEY: 'sentinel', GH_TOKEN: 'sentinel', NODE_OPTIONS: 'sentinel' }
    const env = personalDesktopPackageEnvironment(parent)
    expect(env).toEqual({ PATH: 'tools', HTTPS_PROXY: parent.HTTPS_PROXY, PYTHON: 'python.exe',
      DSH_DESKTOP_PERSONAL: '1', DSH_DESKTOP_APP_ID: 'local.dsh.personal', DSH_DESKTOP_UNSIGNED: '1' })
    expect(() =>{  validateDesktopPackageEnvironment(env, target, { personal: true, unsigned: true }) }).not.toThrow()
    expect(() =>{  validateDesktopPackageEnvironment(env, target, { unsigned: true }) }).toThrow('explicit --personal')
    expect(() =>{  validateDesktopPackageEnvironment(env, target, { personal: true }) }).toThrow('--personal requires')
    expect(parent.DSH_HOME).toBe('official-home')
  })

  it('derives separate installation, updater and application metadata from the merged manifest', () => {
    const config = createElectronBuilderConfig(personalDesktopPackageEnvironment({}), 'win32', 'x64')
    expect(config).toMatchObject({ appId: 'local.dsh.personal', productName: 'DSH Personal', protocols: [], publish: null,
      artifactName: 'dsh-personal-${version}-${os}-${arch}-unsigned.${ext}' })
    expect(config.extraMetadata).toMatchObject({ name: 'dsh-personal', productName: 'DSH Personal', dshPersonalBuild: true,
      dshDesktopAppId: 'local.dsh.personal' })
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    const packager = new Packager({ projectDir: tmpdir() })
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as object
    Object.defineProperties(packager, { config: { value: config }, metadata: { value: { ...metadata, ...config.extraMetadata } } })
    const info = new AppInfo(packager, undefined)
    expect(info.name).toBe('dsh-personal')
    expect(info.productName).toBe('DSH Personal')
    expect(info.updaterCacheDirName).toBe('dsh-personal-updater')
    expect(() => createElectronBuilderConfig({ ...personalDesktopPackageEnvironment({}), DSH_DESKTOP_UNSIGNED: '0' }, 'win32', 'x64')).toThrow('personal builds require')
    expect(() => createElectronBuilderConfig(personalDesktopPackageEnvironment({}), 'darwin', 'x64')).toThrow('personal builds require')
  })
})

describe('early personal Desktop identity', () => {
  function fixture(packaged = true) {
    return { isPackaged: packaged, getAppPath: () => 'app', getPath: vi.fn(() => 'app-data'), setName: vi.fn(), setPath: vi.fn() }
  }
  it('sets userData and both Harness homes before consumers can read them', () => {
    const app = fixture()
    const env = { DSH_HOME: 'official-home', DSH_AGENTS_HOME: 'official-agents' }
    const read = vi.fn(() => ({ dshPersonalBuild: true }))
    expect(initializePersonalDesktop(app, read, env)).toBe(true)
    expect(read).toHaveBeenCalledExactlyOnceWith(join('app', 'package.json'))
    expect(app.setName).toHaveBeenCalledExactlyOnceWith('DSH Personal')
    expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', join('app-data', 'DSH Personal'))
    expect(env).toEqual({ DSH_HOME: join('app-data', 'DSH Personal', 'harness'), DSH_AGENTS_HOME: join('app-data', 'DSH Personal', 'harness', 'agents') })
  })
  it.each([undefined, null, {}, { dshPersonalBuild: 'true' }, { dshPersonalBuild: 1 }, { dshPersonalBuild: false }])('keeps official roots unchanged for %j', (manifest) => {
    const app = fixture()
    const env = { DSH_HOME: 'official-home', DSH_DESKTOP_PERSONAL: '1' }
    expect(initializePersonalDesktop(app, () => manifest, env)).toBe(false)
    expect(app.setName).not.toHaveBeenCalled()
    expect(app.setPath).not.toHaveBeenCalled()
    expect(env.DSH_HOME).toBe('official-home')
    expect(isPersonalBuildManifest(manifest)).toBe(false)
  })
  it('does not read metadata or change homes during development', () => {
    const read = vi.fn()
    expect(initializePersonalDesktop(fixture(false), read, {})).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
  it('stops on unreadable packaged metadata before selecting an official root', () => {
    const app = fixture()
    expect(() => initializePersonalDesktop(app, () => { throw new Error('manifest unreadable') }, {})).toThrow('manifest unreadable')
    expect(app.setPath).not.toHaveBeenCalled()
  })
})
