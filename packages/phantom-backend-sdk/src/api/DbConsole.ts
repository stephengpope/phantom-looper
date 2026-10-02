// DbConsole — CloudBeaver at /db on this server's address behind this
// server's key: the proxy, the connections it shows (ours + every
// agent database), and the db_ui_enabled switch. Stub.
export class DbConsole {
  /** Start or stop the console to match the setting; register connections. */
  async reconcile(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
