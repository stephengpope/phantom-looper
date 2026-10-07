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
  agentTypes: appAgentTypes,
  // The engines that open sessions for themselves; a default list leaves those out.
  backgroundStarters: [LOOPER_STARTER],
  // Sign-in (people, organizations, invitations, API keys — docs/multi-user.md)
  // is on when the phantom admin sets AUTH_SECRET; nothing in this app uses it yet.
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
