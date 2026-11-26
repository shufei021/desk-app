/** Deployment limits; no provider credentials are accepted in plugin configuration. */
import Schema from '@deepseek-ai/schemastery'

/** Limits shared by protocol execution, retained history and private media. */
export interface Config {
  /** Harness home override; omission uses normal DSH_HOME resolution. */
  dshHome?: string
  /** Total chat/image deadline, including response consumption. */
  requestTimeoutMs: number
  /** Total video deadline, including submission, polling and download. */
  videoTimeoutMs: number
  /** Delay between successful video status reads. Failed reads are not retried. */
  pollIntervalMs: number
  /** Maximum request JSON and complete retained input bytes. */
  maxRequestBytes: number
  /** Maximum accumulated non-media response bytes per run. */
  maxResponseBytes: number
  /** Maximum bytes for each image/video and all media in one run. */
  maxMediaBytes: number
  /** Maximum simultaneous provider runs; excess calls fail rather than queue. */
  maxConcurrent: number
  /** Maximum retained settled runs; active runs are never evicted. */
  maxHistory: number
}

/** Schemastery validation also runs when constructed outside the Loader. */
export const configSchema: Schema<Partial<Config>, Config> = Schema.object({
  dshHome: Schema.string(),
  requestTimeoutMs: Schema.natural().min(1).max(3_600_000).default(120_000),
  videoTimeoutMs: Schema.natural().min(1).max(86_400_000).default(900_000),
  pollIntervalMs: Schema.natural().min(1).max(60_000).default(2_000),
  maxRequestBytes: Schema.natural().min(1).default(1024 * 1024),
  maxResponseBytes: Schema.natural().min(1).default(32 * 1024 * 1024),
  maxMediaBytes: Schema.natural().min(1).default(100 * 1024 * 1024),
  maxConcurrent: Schema.natural().min(1).max(64).default(2),
  maxHistory: Schema.natural().min(1).default(100),
})
