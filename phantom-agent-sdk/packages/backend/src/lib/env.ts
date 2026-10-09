// Boot-and-connect configuration ONLY. Every behavioral knob lives in the
// database (storage/Settings.ts) so it can change without a restart — env is what
// you need before you can reach the database at all.
import { SERVICE_ROLE_KEY_PREFIX } from '@phantom-agent-sdk/client';

export interface Env {
  /** The bootstrap superuser's. Boot uses it once (the roles), the console
   *  connects as it; the running backend is on its own role (Database). */
  databaseUrl: string;
  workspaceRoot: string;
  port: number;
  /** The service role key: the server's own credential, which bypasses
   *  every fence. `ph_service_role_` + the secret (SERVICE_ROLE_KEY). */
  serviceRoleKey: string;
  encryptionKey: Buffer; // 32 bytes, AES-256-GCM
  /** Where this backend is reached from outside (`https://<BACKEND_ADDRESS>`):
   *  what links in mail and sign-in point at. Loopback when no address is set. */
  publicUrl: string;
}

// The two facts about THIS build that several files read: its version and
// its own image name. Read here once, defaulted once — not in each file.

/** The release this server is (`vX.Y.Z`), or 'dev' for a checkout. Baked in
 *  by the release workflow. */
export const APP_VERSION: string = process.env.APP_VERSION ?? 'dev';

/** The api's OWN image name. A container cannot name its own image from
 *  inside; compose hands it in so the disk cleanup can prune its old tags. */
export const API_IMAGE: string = process.env.API_IMAGE ?? 'ghcr.io/stephengpope/phantom-backend';

/** The session image's name (no tag): what an update pulls beside the api's. */
export const SESSION_IMAGE: string = process.env.SESSION_IMAGE ?? 'ghcr.io/stephengpope/phantom-backend-session';

/** The secret after the prefix: at least this long. install.sh and setup.sh
 *  write 48 hex characters; a placeholder must not boot a server. */
const SERVICE_ROLE_SECRET_MIN = 32;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const need = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`${name} is required (see .env.example)`);
    return value;
  };
  const rawKey = need('ENCRYPTION_KEY');
  const encryptionKey = Buffer.from(rawKey, 'base64');
  // Fail at boot, not at the first credential write — a wrong-length key would
  // otherwise surface as an AES error long after anyone was looking.
  if (encryptionKey.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }
  // The bearer is the API's ONLY lock. The prefix is what tells it from a
  // user's key everywhere a key is read — a key without it is not one.
  const serviceRoleKey = need('SERVICE_ROLE_KEY');
  if (!serviceRoleKey.startsWith(SERVICE_ROLE_KEY_PREFIX) || serviceRoleKey.length < SERVICE_ROLE_KEY_PREFIX.length + SERVICE_ROLE_SECRET_MIN) {
    throw new Error(`SERVICE_ROLE_KEY must be ${SERVICE_ROLE_KEY_PREFIX} followed by at least ${SERVICE_ROLE_SECRET_MIN} characters (${SERVICE_ROLE_KEY_PREFIX}$(openssl rand -hex 24))`);
  }
  const port = Number(source.PORT ?? 8080);
  const address = source.BACKEND_ADDRESS?.trim();
  return {
    databaseUrl: need('DATABASE_URL'),
    workspaceRoot: need('WORKSPACE_ROOT_PATH'),
    port,
    serviceRoleKey,
    encryptionKey,
    publicUrl: address ? `https://${address}` : `http://127.0.0.1:${port}`,
  };
}
