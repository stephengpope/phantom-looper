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

// The two facts about THIS build that several files read: its version and
// its own image name. Read here once, defaulted once — not in each file.

/** The release this server is (`vX.Y.Z`), or 'dev' for a checkout. Baked in
 *  by the release workflow. */
export const APP_VERSION: string = process.env.APP_VERSION ?? 'dev';

/** The api's OWN image name. A container cannot name its own image from
 *  inside; compose hands it in so the disk cleanup can prune its old tags. */
export const API_IMAGE: string = process.env.API_IMAGE ?? 'ghcr.io/stephengpope/phantom-backend-api';

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
  // The bearer is the API's ONLY lock. install.sh writes 48 hex chars; a
  // placeholder like .env.example's `change-me` must not boot a server.
  const apiKey = need('API_KEY');
  if (apiKey.length < 32) throw new Error('API_KEY must be at least 32 characters (openssl rand -hex 24)');
  return {
    databaseUrl: need('DATABASE_URL'),
    workspaceRoot: need('WORKSPACE_ROOT_PATH'),
    port: Number(source.PORT ?? 8080),
    apiKey,
    encryptionKey,
  };
}
