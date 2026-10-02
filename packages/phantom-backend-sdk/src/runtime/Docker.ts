// Docker — the dockerode client on the API socket (never the CLI). Stub.
export class Docker {
  readonly client!: unknown;   // dockerode
  /** Find the socket (env, /var/run, ~/.docker) and connect. */
  static connect(socketPath?: string): Docker { throw stub(); }
}
const stub = () => new Error('stub');
