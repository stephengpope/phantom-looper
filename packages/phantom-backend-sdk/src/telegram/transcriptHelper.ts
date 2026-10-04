// The last assistant message in a transcript — the same reading as
// lastUserFromJsonl (phantom-client-sdk/transcript), for the other role.
import { parseLines } from 'phantom-client-sdk/transcript';

/** The last thing the assistant said. Text only; tool calls are skipped. */
export function lastAssistantFromJsonl(text: string): string | undefined {
  let last: string | undefined;
  for (const l of parseLines(text)) {
    if (l.type !== 'message' || l.message.role !== 'assistant') continue;
    const c = l.message.content;
    const t = typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('');
    if (t.trim()) last = t.trim().replace(/\s+/g, ' ');
  }
  return last;
}
