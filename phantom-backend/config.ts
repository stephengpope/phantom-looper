// What this app declares to the backend SDK: its settings, its agent types,
// which of its engines open background sessions, the bot's command menu.
// index.ts completes the config with what needs the running backend in hand
// (routes, the git hooks, onStart/onStop). The SDK owns boot, the services,
// the API; this app owns the looper, the three agents, the bot's behaviour.
import type { PhantomBackendConfig } from 'phantom-backend-sdk';
import { appSettings } from './appSettings.js';
import { appAgentTypes } from './appAgentTypes.js';
import { menuFor } from './telegram/commands.js';
import { LOOPER_STARTER } from './looper/engine.js';
import { CRON_STARTER } from './crons/engine.js';

export const config: PhantomBackendConfig = {
  settings: appSettings,
  agentTypes: appAgentTypes,
  // The engines that open sessions for themselves; a default list leaves those out.
  backgroundStarters: [LOOPER_STARTER, CRON_STARTER],
  // The bot's command menu — the global default, and the authorized chat's for its mode.
  telegramCommandMenu: async (state) => ({ global: menuFor('assistant'), forChat: menuFor(state.mode) }),
};
