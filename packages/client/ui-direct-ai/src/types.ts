/** Shared browser configuration; contains no credentials or request data. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Initial navigation choice for the personal direct-provider page. */
export interface DirectPageConfig {
  /** Open the direct page initially; the Agent conversation remains available from navigation. */
  openOnStart: Volatile<boolean>
}
