import { pino } from 'pino';

const root = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function logger(component: string) {
  return root.child({ component });
}

/** One-line error rendering for log fields — stack traces go to debug, not info. */
export function errStr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
