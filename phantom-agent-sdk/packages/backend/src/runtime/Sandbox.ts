// The Sandbox — the one way a command runs in a workspace container. Two
// rules make it safe with no path-checking code of our own:
//
//   run() takes argv, never a shell string. A filename with a backtick is a
//   filename. A shell only exists when a caller explicitly asks for one.
//
//   File content rides the command's streams, never the command line. Reads
//   are `cat` with stdout collected; writes are `cat > path` with the bytes
//   piped to stdin — binary-safe, no ARG_MAX ceiling, and the file is written
//   inside the container as its user, so ownership and mtime are right by
//   construction (why putArchive was dropped).
//
// The exec itself is an `Exec`: DockerExec speaks dockerode to a container
// on this process's daemon (the ONLY module that does — knack's rule for
// @vercel/sandbox, applied here); a remote host's exec sends the same calls
// as jobs. The Sandbox's rules hold whichever runs underneath.
import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import path from 'node:path';

export interface RunResult { stdout: Buffer; stderr: Buffer; exitCode: number }

export interface RunOpts {
  cwd?: string;
  stdin?: Buffer;
  /** Soft cap per stream; collection stops growing past it (the process still
   *  runs to completion). Callers surface truncation in the envelope. */
  maxBytes?: number;
  timeoutMs?: number;
}

/** One record of a streamed command: a chunk of one stream, or its end —
 *  exactly one terminal record (`exit` or `error`) closes every stream. */
export type StreamRecord = { seq: number; stream?: 'stdout' | 'stderr'; data?: string; event?: string; code?: number; reason?: string };

/** What runs a command in the container. */
export interface Exec {
  runOnce(argv: string[], opts: RunOpts): Promise<RunResult>;
  runStream(argv: string[], opts: { cwd?: string; timeoutMs?: number }): AsyncGenerator<StreamRecord>;
}

/** The error a timed-out run rejects with: the output collected so far rides
 *  on it — a killed command's last lines are what the agent needs to make
 *  its next call right. */
export const execTimeout = (stdout: Buffer, stderr: Buffer) =>
  Object.assign(new Error('exec timeout'), { code: 'exec_timeout', stdout, stderr });

export class DockerExec implements Exec {
  constructor(private docker: Docker, private container: Docker.Container) {}

  async runOnce(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
    const exec = await this.container.exec({
      Cmd: argv,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: opts.stdin !== undefined,
      Tty: false, // a TTY merges the streams and rewrites line endings — tagging is unrecoverable (T16)
      WorkingDir: opts.cwd ?? '/workspace/repo',
    });
    const stream = await exec.start({ hijack: true, stdin: opts.stdin !== undefined });

    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    const out: Buffer[] = []; const errB: Buffer[] = [];
    let outLen = 0; let errLen = 0;
    const outSink = new PassThrough(); const errSink = new PassThrough();
    outSink.on('data', (chunk: Buffer) => { if (outLen < max) { out.push(chunk); outLen += chunk.length; } });
    errSink.on('data', (chunk: Buffer) => { if (errLen < max) { errB.push(chunk); errLen += chunk.length; } });
    this.docker.modem.demuxStream(stream, outSink, errSink);

    if (opts.stdin !== undefined) { stream.write(opts.stdin); (stream as unknown as { end: () => void }).end(); }

    await new Promise<void>((resolveP, rejectP) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => { stream.destroy(); rejectP(execTimeout(Buffer.concat(out), Buffer.concat(errB))); }, opts.timeoutMs)
        : null;
      stream.on('end', () => { if (timer) clearTimeout(timer); resolveP(); });
      stream.on('error', (error) => { if (timer) clearTimeout(timer); rejectP(error); });
    });
    const info = await exec.inspect();
    return { stdout: Buffer.concat(out), stderr: Buffer.concat(errB), exitCode: info.ExitCode ?? 0 };
  }

  /** Streaming variant for the exec tool: yields tagged records in arrival
   *  order, always ending with exactly one terminal record. Frames are chunks,
   *  not lines (T15) — no line assumptions here or downstream. */
  async *runStream(argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}): AsyncGenerator<StreamRecord> {
    const exec = await this.container.exec({
      Cmd: argv, AttachStdout: true, AttachStderr: true, Tty: false,
      WorkingDir: opts.cwd ?? '/workspace/repo',
    });
    const stream = await exec.start({ hijack: true });
    const chunks: Array<{ stream: 'stdout' | 'stderr'; data: Buffer }> = [];
    let done = false; let failed: Error | null = null;
    let wake: (() => void) | null = null;
    const outSink = new PassThrough(); const errSink = new PassThrough();
    outSink.on('data', (chunk: Buffer) => { chunks.push({ stream: 'stdout', data: chunk }); wake?.(); });
    errSink.on('data', (chunk: Buffer) => { chunks.push({ stream: 'stderr', data: chunk }); wake?.(); });
    this.docker.modem.demuxStream(stream, outSink, errSink);
    stream.on('end', () => { done = true; wake?.(); });
    stream.on('error', (error) => { failed = error; done = true; wake?.(); });
    const timer = opts.timeoutMs
      ? setTimeout(() => { failed = Object.assign(new Error('timeout'), { code: 'exec_timeout' }); stream.destroy(); }, opts.timeoutMs)
      : null;

    let seq = 0;
    try {
      for (;;) {
        while (chunks.length) {
          const chunk = chunks.shift()!;
          yield { seq: seq++, stream: chunk.stream, data: chunk.data.toString('utf8') };
        }
        if (done) break;
        await new Promise<void>((resume) => { wake = resume; });
        wake = null;
      }
      if (failed) {
        const reason = (failed as { code?: string }).code === 'exec_timeout' ? 'timeout' : 'container_gone';
        yield { seq: seq++, event: 'error', reason };
      } else {
        const info = await exec.inspect().catch(() => null);
        yield { seq: seq++, event: 'exit', code: info?.ExitCode ?? -1 };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class Sandbox {
  constructor(private exec: Exec) {}

  /** Resolve a tool path. Relative paths are repo-relative; absolute paths are
   *  container-absolute. There is nothing to escape TO — the container's only
   *  mount is this session — so this is normalization, not a boundary. */
  static resolvePath(filePath: string): string {
    return path.posix.resolve('/workspace/repo', filePath);
  }

  async run(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
    // A container that has just started can accept exec create but fail to
    // spawn ("error writing config to pipe: broken pipe"). Transient by
    // nature — retry briefly rather than surfacing it to the agent.
    for (let attempt = 0; ; attempt++) {
      try { return await this.exec.runOnce(argv, opts); }
      catch (error) {
        const msg = String((error as Error).message ?? error);
        if (attempt >= 3 || !/broken pipe|OCI runtime|not running|is restarting/i.test(msg)) throw error;
        await new Promise((wake) => setTimeout(wake, 150 * (attempt + 1)));
      }
    }
  }

  runStream(argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}): AsyncGenerator<StreamRecord> {
    return this.exec.runStream(argv, opts);
  }

  async readFile(filePath: string, opts: { maxBytes?: number } = {}): Promise<{ content: Buffer; exitCode: number; stderr: string }> {
    const abs = Sandbox.resolvePath(filePath);
    const ran = await this.run(['cat', abs], { maxBytes: opts.maxBytes });
    return { content: ran.stdout, exitCode: ran.exitCode, stderr: ran.stderr.toString('utf8') };
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const abs = Sandbox.resolvePath(filePath);
    const dir = path.posix.dirname(abs);
    await this.run(['mkdir', '-p', dir]);
    // `$1` is a positional parameter, not interpolation — the path never enters
    // the command text.
    const ran = await this.run(['sh', '-c', 'cat > "$1"', 'sh', abs], { stdin: content });
    if (ran.exitCode !== 0) throw new Error(`write failed: ${ran.stderr.toString('utf8').slice(0, 200)}`);
  }
}
