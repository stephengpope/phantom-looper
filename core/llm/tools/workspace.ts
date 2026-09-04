/**
 * The WORKSPACE kit — the seven file tools (`bash read write edit ls find
 * grep`). Needs: a phantom-backend and a session. Any agent whose host has
 * those can carry this kit (the coding agent does; the Assistant could).
 *
 * The definitions are not written here — they live in ONE place, the server's
 * `server/tools/registry.ts`, and arrive over `GET /tools`; this kit turns each
 * into an AI SDK tool that POSTs back with the session header. The session id
 * and base URL never appear in a schema the model sees.
 *
 * `pick` bounds the kit: a list of names, or 'readonly' for the tools the
 * server marks as not mutating (read ls find grep). Default: all of them.
 *
 *   import { phantomTools } from '../core/llm/tools/workspace.js';
 *   const tools = await phantomTools({ baseUrl, apiKey, sessionId });
 *
 * Requires the `ai` package (v5+) as a peer.
 */
import { jsonSchema, tool, type Tool } from 'ai';

export interface PhantomConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  /** Which tools to take: names, or 'readonly' (the server's `mutates: false`
   *  set). Absent = the whole kit. An unknown name is an error — a silently
   *  missing tool is how an agent loses a capability without anyone noticing. */
  pick?: string[] | 'readonly';
  fetch?: typeof fetch;
}

interface ToolListing {
  sessionHeader: string;
  tools: { name: string; summary: string; description?: string; input: Record<string, unknown>; mutates: boolean }[];
}

/** Filter the listing by `pick`. Exported for tests. */
export function pickTools<T extends { name: string; mutates: boolean }>(tools: T[], pick?: string[] | 'readonly'): T[] {
  if (!pick) return tools;
  if (pick === 'readonly') return tools.filter((t) => !t.mutates);
  const have = new Set(tools.map((t) => t.name));
  const missing = pick.filter((n) => !have.has(n));
  if (missing.length) throw new Error(`unknown tool(s): ${missing.join(', ')}`);
  const want = new Set(pick);
  return tools.filter((t) => want.has(t.name));
}

export async function phantomTools(cfg: PhantomConfig): Promise<Record<string, Tool>> {
  const f = cfg.fetch ?? fetch;
  const res = await f(`${cfg.baseUrl}/tools`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`GET /tools failed: ${res.status}`);
  const listing = (await res.json() as { data: ToolListing }).data;

  const out: Record<string, Tool> = {};
  for (const def of pickTools(listing.tools, cfg.pick)) {
    out[def.name] = tool({
      description: def.description ?? def.summary,
      inputSchema: jsonSchema(def.input as never),
      // Image reads reach the model as an image, not a JSON blob of base64.
      toModelOutput: ({ output }) => {
        const img = (output as { data?: { image?: { media_type: string; base64: string } } })?.data?.image;
        if (img) {
          return { type: 'content', value: [{ type: 'file', mediaType: img.media_type, data: { type: 'data', data: img.base64 } }] } as never;
        }
        return { type: 'json', value: output as never };
      },
      // The SDK's abortSignal rides into the fetch: esc aborts the request,
      // and the server kills the running command's process group on the
      // disconnect. Without it an ignored signal holds the whole turn until
      // the tool settles — bash has no timeout by default.
      execute: async (args: unknown, opts?: { abortSignal?: AbortSignal }) => {
        const r = await f(`${cfg.baseUrl}/tools/${def.name}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
            [listing.sessionHeader]: cfg.sessionId,
          },
          body: JSON.stringify(args ?? {}),
          signal: opts?.abortSignal,
        });
        // The envelope IS the result — errors included. The model reads
        // {ok:false, error:{code, message, retryable}} and self-corrects;
        // throwing here would turn actionable detail into a generic failure.
        return r.json();
      },
    });
  }
  return out;
}
