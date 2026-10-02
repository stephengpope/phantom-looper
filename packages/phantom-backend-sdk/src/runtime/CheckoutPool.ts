// CheckoutPool — warm clones of every project, ready to become a
// workspace by one atomic rename. Stocked by the maintenance tick. Stub.
export class CheckoutPool {
  /** Claim a ready clone of the project into dest; false when none is ready. */
  async claim(projectId: string, dest: string): Promise<boolean> { throw stub(); }
  /** Stock each project up to its spare_clones setting. */
  async stock(): Promise<void> { throw stub(); }
  /** Remove half-made slots a crash left behind. */
  async cleanAtBoot(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
