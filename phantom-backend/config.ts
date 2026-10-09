// What this app declares to the backend SDK: its migrations, its settings,
// its agent types, which of its engines open background sessions. index.ts
// completes the config with what needs the running backend in hand (routes,
// the git hooks, the bot's command menu, onStart/onStop). The SDK owns boot,
// the services, the API; this app owns the looper, the three agents, the
// bot's behaviour.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhantomBackendConfig } from '@phantom-agent-sdk/backend';
import { appSettings } from './appSettings.js';
import { appAgentTypes } from './appAgentTypes.js';
import { LOOPER_STARTER } from './looper/Looper.js';

export const config: PhantomBackendConfig = {
  // This app's tables, in its schema, with their own ledger — run after the
  // SDK's. The folder rides beside this file in src and in dist (the build
  // copies it).
  migrations: { dir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'), ledgerSchema: 'phantom_looper' },
  settings: appSettings,
  // What a deployment may fix in .env, each by its own name in capitals
  // (SMTP_HOST=… fixes smtp_host): its mail, Telegram, storage, containers,
  // the server's switches, and default keys when the server pays for everyone.
  envSettings: [
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
    'telegram_enabled', 'telegram_bot_token',
    'media_endpoint', 'media_region', 'media_bucket', 'media_access_key_id', 'media_secret_access_key',
    'container_image', 'container_docker', 'container_runtime', 'container_sudo', 'container_disk_gb',
    'container_memory_mb', 'container_cpus', 'container_pids_limit',
    'api_docs_enabled', 'db_ui_enabled', 'disk_cleanup_percent', 'update_check_interval_ms',
    'anthropic_api_key', 'openai_api_key', 'google_api_key', 'deepseek_api_key', 'kimi_api_key', 'xai_api_key',
    'mistral_api_key', 'groq_api_key', 'openai_compatible_api_key', 'github_token', 'firecrawl_api_key', 'deepgram_api_key',
  ],
  agentTypes: appAgentTypes,
  // The engines that open sessions for themselves; a default list leaves those out.
  backgroundStarters: [LOOPER_STARTER],
  // Sign-in (people, organizations, invitations, API keys — docs/multi-user.md)
  // is on when AUTH_SECRET is set; nothing in this app uses it yet.
  // Off by default: no route, nothing written.
  // Password sign-in with AUTH_PASSWORD=1; GitHub with AUTH_GITHUB_CLIENT_ID +
  // AUTH_GITHUB_CLIENT_SECRET. The mails' wording is the SDK's default here.
  ...(process.env.AUTH_SECRET ? { identity: { secret: process.env.AUTH_SECRET,
    trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    signIn: {
      password: process.env.AUTH_PASSWORD === '1',
      ...(process.env.AUTH_GITHUB_CLIENT_ID && process.env.AUTH_GITHUB_CLIENT_SECRET
        ? { github: { clientId: process.env.AUTH_GITHUB_CLIENT_ID, clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET } } : {}),
    } } } : {}),
};
