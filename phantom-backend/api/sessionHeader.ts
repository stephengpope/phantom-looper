// The header every tool call carries its session id in, and the ONE gate
// every tool route puts that session through. In its own module because
// routes read the header name at LOAD time, to build their route schemas:
// importing it from fs.ts pulled every reader into fs.ts's import cycle
// (fs → app → git → fs), which crashes any entry that loads fs.ts first.
import type { SessionRow } from 'phantom-backend-sdk/schema';
import { workspaceOf, type Sessions } from '../sessions.js';
import { ToolError } from '../tools/envelope.js';

export const SESSION_HEADER = 'x-phantom-looper-session';

/** The session a tool call names, checked the one way every tool route
 *  checks it: named, known, its files still on disk, a workspace to open. A
 *  tool call is use — the checkout is touched. Throws ToolError (the routes
 *  map codes to HTTP); returns the row and THE workspace its tools open. */
export async function toolSession(sessions: Sessions, headers: Record<string, unknown>):
Promise<{ session: SessionRow; workspaceId: string }> {
  const id = String(headers[SESSION_HEADER] ?? '');
  if (!id) throw new ToolError('session_not_found', `missing ${SESSION_HEADER} header`);
  const session = await sessions.get(id);
  if (!session) throw new ToolError('session_not_found', `no session ${id}`);
  if (session.status !== 'active') throw new ToolError('session_destroyed', `session is ${session.status}`);
  if (!session.workspaceId) throw new ToolError('no_workspace', 'this session has no files — nothing to read');
  void sessions.touch(session);
  return { session, workspaceId: workspaceOf(session) };
}
