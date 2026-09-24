// Every error the SDK produces is a PhantomError with a code from ErrorCode.
// A client tells them apart by code; the message is for a person; `cause`
// carries what actually failed (ES2022 error chaining) so the stack is never
// cut.

export const ERROR_CODES = [
  'session_locked',
  'session_not_found',
  'transcript_conflict',
  'transcript_write_failed',
  'transcript_invalid',
  'model_error',
  'context_too_long',
  'no_api_key',
  'tool_build_failed',
  'readonly',
  'busy',
  'prompt_frozen',
  'config_invalid',
  'compaction_failed',
  'backend_error',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export class PhantomError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, opts: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PhantomError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
  }
}

/** The provider said the conversation no longer fits its window. One
 *  classification for every provider's wording; the client says "compact". */
export function isContextTooLong(message: string): boolean {
  return /prompt is too long|request too large|context[_ ]length[_ ]exceeded|maximum context length|too many tokens|input is too long/i.test(message);
}

export function isPhantomError(e: unknown): e is PhantomError {
  return e instanceof PhantomError;
}

/** Anything thrown becomes a PhantomError, once. A PhantomError passes
 *  through untouched; anything else is wrapped with `code` and kept as cause. */
export function asPhantomError(e: unknown, code: ErrorCode, context: string): PhantomError {
  if (isPhantomError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new PhantomError(code, `${context}: ${msg}`, { cause: e });
}
