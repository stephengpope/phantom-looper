// Sandbox — run a command, read or write a file inside a session's
// container. The ONLY object that talks to the container SDK. Stub.
export interface RunResult { exitCode: number; stdout: string; stderr: string; truncated: boolean }
export interface RunOptions { timeoutMs?: number; cwd?: string; env?: Record<string, string>; stdin?: string; maxBytes?: number }

export class Sandbox {
  async run(argv: string[], options?: RunOptions): Promise<RunResult> { throw stub(); }
  async readFile(path: string, options?: { maxBytes?: number }): Promise<Buffer> { throw stub(); }
  async writeFile(path: string, content: Buffer): Promise<void> { throw stub(); }
  /** A path as the container sees it, resolved under /workspace. */
  static resolvePath(path: string): string { throw stub(); }
}
const stub = () => new Error('stub');
