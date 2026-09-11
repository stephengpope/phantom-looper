// Extract the last assistant message from a JSONL transcript — the same
// shape as lastUserFromJsonl in core/llm/transcript.ts, for the other role.

/** The last thing the assistant said in a JSONL transcript. Returns the text
 *  content only (tool calls are skipped). */
export function lastAssistantFromJsonl(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: { role?: string; content?: unknown };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.role !== 'assistant') continue;
    const t = typeof e.content === 'string'
      ? e.content
      : Array.isArray(e.content)
        ? e.content.filter((c: { type?: string }) => c?.type === 'text')
            .map((c: { text?: string }) => c.text ?? '').join('')
        : '';
    if (t.trim()) last = t.trim().replace(/\s+/g, ' ');
  }
  return last;
}
