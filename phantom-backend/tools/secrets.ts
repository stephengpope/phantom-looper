// The SECRET tools — secret_list, secret_get: the stored secrets, over
// Settings' secret layer. Read-only by design. Bound to the session's
// workspace: its secrets shadow global ones by name.
import { GLOBAL, workspaceScope } from '../store.js';
import { secretName } from '../../core/secretName.js';
import { obj, refusal, str, type ToolCtx, type ToolDef } from './def.js';

const chain = (ctx: ToolCtx) => [GLOBAL, workspaceScope(ctx.workspace.id)];

export const SECRET_TOOLS: ToolDef[] = [
  {
    name: 'secret_list',
    summary: 'The stored secrets — names and descriptions, never values.',
    description: 'The stored secrets — names and descriptions, never values. The index in your ' +
      'instructions was written when this session started; use this when a secret might have ' +
      'been added since, or the one you expected is missing.',
    input: obj({}),
    mutates: false, agents: ['coding'],
    async execute(ctx) {
      const raw = await ctx.app.settings.listSecrets(chain(ctx));
      return { secrets: raw.map((s) => ({ name: s.name, description: s.description, scope: s.scope === GLOBAL ? 'global' : 'workspace' })) };
    },
  },
  {
    name: 'secret_get',
    summary: "One stored secret's value, by name.",
    description: 'One stored secret\'s value, by name — tokens and credentials the user saved ' +
      'for your use in this project (API keys, service tokens). Use the real value it returns ' +
      'in commands, config and .env files; never invent a placeholder when a stored secret ' +
      'covers the need. The names are in your instructions\' secrets index, or secret_list.',
    input: obj({ name: str('the secret\'s name, from the index in your instructions or secret_list') }, ['name']),
    mutates: false, agents: ['coding'],
    async execute(ctx, a) {
      const name = secretName(String(a.name));
      const value = name ? await ctx.app.settings.readSecretValue(name, chain(ctx)) : undefined;
      if (value === undefined) {
        const names = (await ctx.app.settings.listSecrets(chain(ctx))).map((s) => s.name);
        throw refusal('not_found', `no secret named "${String(a.name)}" — stored: ${names.length ? names.join(', ') : '(none)'}`);
      }
      return { name, value };
    },
  },
];
