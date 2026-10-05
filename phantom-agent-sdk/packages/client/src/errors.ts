// Every error the SDK produces is a PhantomError: a code that names exactly
// what went wrong, a message for a person, `cause` with what actually failed
// (ES2022 error chaining) so the stack is never cut, and — when the server
// answered — the HTTP status.
//
// The code is the server's own when the server refused (`session_locked`,
// `unauthorized`, `not_found`, `unpushed_work`… as the route sent it, never
// renamed), or one of SDK_ERROR_CODES when the failure happened here.

/** The failures that happen on this side, not on the server. */
export const SDK_ERROR_CODES = [
  'unreachable',            // the request never got an answer (network)
  'bad_response',           // the server answered, but not with an envelope
  'not_a_stream',           // a stream route answered plain data
  'sdk_version_mismatch',   // the backend runs another SDK version (BackendClient.connect)
  'transcript_conflict',
  'transcript_write_failed',
  'transcript_invalid',
  'model_error',
  'context_too_long',
  'no_api_key',
  'tool_build_failed',
  'tool_loop',              // the same tool call failed TOOL_FAILURE_LIMIT times in a row (turn.ts)
  'readonly',
  'busy',
  'config_invalid',
  'listener_threw',         // an app's event listener threw
  'internal',               // the SDK's own code threw where it should not
] as const;
export type SdkErrorCode = typeof SDK_ERROR_CODES[number];
/** An SDK code, or any code the server sent. */
export type ErrorCode = SdkErrorCode | (string & {});

export class PhantomError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** The HTTP status, when the server answered. */
  readonly status: number | undefined;
  constructor(code: ErrorCode, message: string, opts: { cause?: unknown; retryable?: boolean; status?: number } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PhantomError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}

export function isPhantomError(error: unknown): error is PhantomError {
  return error instanceof PhantomError;
}

/** Anything thrown becomes a PhantomError, once. A PhantomError passes
 *  through untouched; anything else is wrapped with `code` and kept as cause. */
export function asPhantomError(error: unknown, code: ErrorCode, context: string): PhantomError {
  if (isPhantomError(error)) return error;
  const msg = error instanceof Error ? error.message : String(error);
  return new PhantomError(code, `${context}: ${msg}`, { cause: error });
}
