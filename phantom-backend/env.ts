// Boot-and-connect configuration ONLY. Every behavioral knob lives in the
// database (server/settings.ts) so it can change without a restart — env is what
// you need before you can reach the database at all.

export interface Env {
  databaseUrl: string;
  workspaceRoot: string;
  port: number;
  apiKey: string;
  encryptionKey: Buffer; // 32 bytes, AES-256-GCM
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const need = (k: string): string => {
    const v = source[k];
    if (!v) throw new Error(`${k} is required (see .env.example)`);
    return v;
  };
  const rawKey = need('ENCRYPTION_KEY');
  const encryptionKey = Buffer.from(rawKey, 'base64');
  // Fail at boot, not at the first credential write — a wrong-length key would
  // otherwise surface as an AES error long after the operator stopped looking.
  if (encryptionKey.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }
  return {
    databaseUrl: need('DATABASE_URL'),
    workspaceRoot: need('WORKSPACE_ROOT_PATH'),
    port: Number(source.PORT ?? 8080),
    apiKey: need('API_KEY'),
    encryptionKey,
  };
}
