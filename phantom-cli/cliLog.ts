// The ONE way into cli.log: every line the app records — background warnings,
// boundary stacks, crashes, the cursor audit's drift catches — passes through
// here and gets its timestamp HERE, so no writer stamps its own (a line with
// two, or none, is a line you cannot line up with what was on screen).
// Best-effort by design: logging must never take the screen down.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';

export const CLI_LOG_PATH = join(CONFIG_DIR, 'cli.log');

export function logLine(text: string): void {
  try { appendFileSync(CLI_LOG_PATH, `[${new Date().toISOString()}] ${text.endsWith('\n') ? text : `${text}\n`}`); }
  catch { /* the screen matters more */ }
}
