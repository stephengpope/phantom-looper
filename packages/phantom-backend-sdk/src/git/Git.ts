// Git — deterministic git run from the API container against the volume.
// Every credential-bearing call the SYSTEM makes happens here. Stub.
export interface GitAuth { url: string; pat?: string }
export type WorkState = 'clean' | 'dirty' | 'ahead' | 'merged' | 'conflict' | 'unknown';

export class Git {
  async cloneFresh(dest: string, auth: GitAuth, branch: string): Promise<void> { throw stub(); }
  async checkoutBranch(dir: string, branch: string, from: string): Promise<{ cutFromSha: string }> { throw stub(); }
  async workState(dir: string, branch: string, baseBranch: string): Promise<WorkState> { throw stub(); }
  async commitAll(dir: string, message: string): Promise<boolean> { throw stub(); }
  async commitStaged(dir: string, message: string): Promise<void> { throw stub(); }
  async pushBranch(dir: string, branch: string, auth: GitAuth, options?: { force?: boolean }): Promise<void> { throw stub(); }
  async pushToBase(dir: string, baseBranch: string, auth: GitAuth): Promise<void> { throw stub(); }
  async fetchBase(dir: string, baseBranch: string, auth: GitAuth): Promise<void> { throw stub(); }
  async hasWorkToLand(dir: string, baseBranch: string): Promise<boolean> { throw stub(); }
  async squashToMergeBase(dir: string, mergeBaseSha: string): Promise<void> { throw stub(); }
  async rebaseOntoBase(dir: string, baseBranch: string): Promise<{ conflict: boolean }> { throw stub(); }
  async rebaseInProgress(dir: string): Promise<boolean> { throw stub(); }
  async rebaseAbort(dir: string): Promise<void> { throw stub(); }
  async landingProblems(dir: string, baseBranch: string): Promise<string[]> { throw stub(); }
  async verifyLanded(dir: string, baseBranch: string): Promise<boolean> { throw stub(); }
  async initializeRemote(dir: string, auth: GitAuth, baseBranch: string): Promise<void> { throw stub(); }
  /** What a failed git call means: auth, network, conflict, other. */
  classifyFailure(error: unknown): 'auth' | 'network' | 'conflict' | 'other' { throw stub(); }
}
const stub = () => new Error('stub');
