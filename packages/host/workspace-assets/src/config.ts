/** Deployment settings of the per-workspace image asset folders. */
import Schema from '@deepseek-ai/schemastery'

/** Plugin configuration; validated both by the Loader and by the service constructor. */
export interface Config {
  /** Directory name the library owns inside each workspace; one path segment, `资产库` by default. */
  folderName: string
  /** Largest stored image in bytes; the same limit bounds every upload and every read. */
  maxAssetBytes: number
}

/** Schemastery validation also runs when the service is constructed outside the Loader. */
export const configSchema: Schema<Partial<Config>, Config> = Schema.object({
  folderName: Schema.string().default('资产库'),
  maxAssetBytes: Schema.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
})
