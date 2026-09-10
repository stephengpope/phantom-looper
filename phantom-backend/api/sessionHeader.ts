// The header every tool call carries its session id in. In its own module
// because routes read it at LOAD time, to build their route schemas:
// importing it from fs.ts pulled every reader into fs.ts's import cycle
// (fs → app → git → fs), which crashes any entry that loads fs.ts first.
export const SESSION_HEADER = 'x-phantom-looper-session';
