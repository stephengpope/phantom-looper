// Disk — the volume's two sweeps, driven from the maintenance loop: the
// idle-backup sweep (push an idle session's work so its files may go)
// and the pressure sweep (delete merged, backed-up checkouts oldest
// first until the disk is under the threshold). Stub.
export interface DiskState { usedPct: number; freeGB: number }

export class Disk {
  async state(): Promise<DiskState> { throw stub(); }
  isTooFull(state: DiskState, thresholdPct: number): boolean { throw stub(); }
  async idleBackupSweep(): Promise<void> { throw stub(); }
  async pressureSweep(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
