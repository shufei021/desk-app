/** Structured, secret-free failures owned by direct AI. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Stable failure classes; provider error bodies and transport details are never exposed. */
export type DirectAiErrorCode =
  | 'DIRECT_AI_FORBIDDEN' | 'DIRECT_AI_INVALID_INPUT' | 'DIRECT_AI_NOT_FOUND'
  | 'DIRECT_AI_NOT_CONFIGURED' | 'DIRECT_AI_BUSY' | 'DIRECT_AI_CLOSED'
  | 'DIRECT_AI_HTTP_FAILED' | 'DIRECT_AI_INVALID_RESPONSE' | 'DIRECT_AI_LIMIT'
  | 'DIRECT_AI_TIMEOUT' | 'DIRECT_AI_CANCELLED' | 'DIRECT_AI_STORAGE_FAILED'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    DIRECT_AI_FORBIDDEN: Record<string, never>
    DIRECT_AI_INVALID_INPUT: Record<string, never>
    DIRECT_AI_NOT_FOUND: Record<string, never>
    DIRECT_AI_NOT_CONFIGURED: Record<string, never>
    DIRECT_AI_BUSY: Record<string, never>
    DIRECT_AI_CLOSED: Record<string, never>
    DIRECT_AI_HTTP_FAILED: Record<string, never>
    DIRECT_AI_INVALID_RESPONSE: Record<string, never>
    DIRECT_AI_LIMIT: Record<string, never>
    DIRECT_AI_TIMEOUT: Record<string, never>
    DIRECT_AI_CANCELLED: Record<string, never>
    DIRECT_AI_STORAGE_FAILED: Record<string, never>
  }
}

/** RemoteError retains HarnessError identity and preserves its stable code on the Gateway wire. */
export class DirectAiError extends RemoteError<DirectAiErrorCode> {
  constructor(code: DirectAiErrorCode, message: string) {
    super(code, message, {})
    this.name = 'DirectAiError'
  }
}
