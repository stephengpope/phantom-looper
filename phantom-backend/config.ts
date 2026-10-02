// What this app is made of: the config phantom-backend hands the backend
// SDK. Nothing here but the registrations and what to start. The SDK owns
// boot, the services, the API; this app owns the looper, the three agents,
// the bot's behaviour.
import type { PhantomBackendConfig } from 'phantom-backend-sdk';
import { appSettings } from './appSettings.js';
import { appAgentTypes } from './appAgentTypes.js';
import { Looper } from './looper/Looper.js';
import { TelegramAssistantBot } from './telegram/TelegramAssistantBot.js';

const engines: { looper?: Looper; bot?: TelegramAssistantBot } = {};

export const config: PhantomBackendConfig = {
  migrations: { dir: 'migrations/app', schema: 'phantom_looper' },
  settings: appSettings,
  agentTypes: appAgentTypes,
  // tools: the looper's card-bound tools are added per run through the client SDK's addToolKit, not here.
  // routes: none yet.
  async onStart(backend) {
    engines.looper = new Looper(backend);
    engines.bot = new TelegramAssistantBot(backend);
    await engines.looper.start();
    await engines.bot.start();
  },
  async onStop() {
    await engines.bot?.stop();
    await engines.looper?.stop();
  },
};
