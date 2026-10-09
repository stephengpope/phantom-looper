// Following a server ND-JSON feed, forever — ONE copy of that policy, and it
// lives in the client SDK now (link.ts: the same loop the session runners and
// the cli's feeds share). Re-exported here so the cli's callers keep their
// import; the cli passes its own Server transport as the `stream`.
export { followStream, STREAM_STALL_MS, type Stream, type FollowHooks } from '@phantom-agent-sdk/client';
