// The last assistant message in a transcript — the same reading as
// lastUserFromJsonl (phantom-client-sdk/transcript), for the other role.
import { parseLines } from 'phantom-client-sdk/transcript';

/** The last thing the assistant said. Text only; tool calls are skipped. */
export function lastAssistantFromJsonl(text: string): string | undefined {
  let last: string | undefined;
  for (const line of parseLines(text)) {
    if (line.type !== 'message' || line.message.role !== 'assistant') continue;
    const content = line.message.content;
    const text = typeof content === 'string' ? content : content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (text.trim()) last = text.trim().replace(/\s+/g, ' ');
  }
  return last;
}
