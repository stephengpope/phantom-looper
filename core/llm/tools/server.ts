/**
 * The SERVER kit — tools that need the API process's own capabilities. Needs:
 * a way to run a command inside a workspace container, which only the server
 * has; the caller plugs that in. Only server-side agents carry this kit (the
 * Git Fixer does).
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

export type ContainerExec = (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** `bash`: the Git Fixer's one capability — run ONE shell command in the
 *  conflicted repo per call (inspect, edit, stage, commit); resolving a
 *  conflict takes a series of calls. It is a shell, so it is named `bash` like
 *  the workspace kit's. Output is truncated so a huge diff cannot flood the
 *  context. */
export function fixerBashTool(exec: ContainerExec): Record<string, Tool> {
  return {
    bash: tool({
      description:
        'Run one shell command in the conflicted repo\'s working directory and see its stdout, stderr and exitCode. ' +
        'This is your only way to inspect and fix the merge: `git status` to see the state, shell commands to edit ' +
        'conflicted files, `git add` and `git commit` to finish. One command per call. stdout is truncated to 8KB ' +
        'and stderr to 4KB — pipe through grep/head when output could be large.',
      inputSchema: z.object({ cmd: z.string().describe('Shell command, e.g. `git status`.') }),
      execute: async ({ cmd }) => {
        const r = await exec(cmd);
        return { stdout: r.stdout.slice(0, 8000), stderr: r.stderr.slice(0, 4000), exitCode: r.exitCode };
      },
    }),
  };
}
