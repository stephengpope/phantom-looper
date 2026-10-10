// The one error/truncation vocabulary every tool speaks. Codes are a CLOSED
// set — a call site inventing a string is a bug.
export class ToolError extends Error {
  constructor(public code: string, message: string, public retryable = false, public detail?: unknown) {
    super(message);
  }
}

export interface Truncation {
  reason: 'max_bytes' | 'limit';
  shown: { from: number; to: number };
  total: number;
  hint: string;
}

/** Binary sniff: a NUL in the first 8KB. Same heuristic git uses. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}
