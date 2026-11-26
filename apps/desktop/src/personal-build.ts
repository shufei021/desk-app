/** Packaged personal identity; ambient flags never select another application's data directory. */
import { join } from 'node:path'

/** Electron startup methods required before locale, logging, locks or Host startup. */
export interface PersonalDesktopApp {
  readonly isPackaged: boolean
  getAppPath(): string
  getPath(name: 'appData'): string
  setName(name: string): void
  setPath(name: 'userData', path: string): void
}

/**
 * Accept only the boolean marker embedded in a packaged manifest.
 * @param manifest - Parsed package metadata.
 * @returns Whether the manifest declares a personal build.
 */
export function isPersonalBuildManifest(manifest: unknown): boolean {
  return typeof manifest === 'object' && manifest !== null && 'dshPersonalBuild' in manifest
    && manifest.dshPersonalBuild === true
}

/**
 * Apply personal storage before any application-owned data is read; normal/development startup is unchanged.
 * Invalid or unreadable packaged metadata aborts startup rather than selecting an uncertain data directory.
 * @param app - Early Electron application hooks.
 * @param readManifest - Synchronous manifest reader; never called in development.
 * @param environment - Startup environment whose Harness homes are overridden for personal builds only.
 * @returns Whether personal identity was applied.
 */
export function initializePersonalDesktop(
  app: PersonalDesktopApp,
  readManifest: (path: string) => unknown,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (!app.isPackaged || !isPersonalBuildManifest(readManifest(join(app.getAppPath(), 'package.json')))) return false
  const userData = join(app.getPath('appData'), 'DSH Personal')
  app.setName('DSH Personal')
  app.setPath('userData', userData)
  environment.DSH_HOME = join(userData, 'harness')
  environment.DSH_AGENTS_HOME = join(userData, 'harness', 'agents')
  return true
}
