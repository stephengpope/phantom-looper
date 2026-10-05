# @phantom-agent-sdk/client

The agent runtime for a phantom backend. A base class that knows how to run
an agent against the server; an app extends it with the agent's type and its
prompt layout. Everything else — the model, the tools, the conversation, the
lock, the record, the tokens, stopping — the runtime does by asking the server.

```ts
import { Agent, BackendClient, agentText, type SystemPromptLayout } from '@phantom-agent-sdk/client';

class CodingAgent extends Agent {
  readonly type = 'coding';   // a type the backend registered
  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: [agentText('You write code.')], context: ['agents_md'], volatile: ['skills_list', 'time_date'],
  };
}

const backend = new BackendClient({ url: 'https://your-server/api', apiKey, clientId: 'my-app' });
const agent = await CodingAgent.resumeSession(backend, { onError: console.error, onNotice: console.log }, sessionId);
agent.on('part', (part) => render(part));
await agent.sendMessage('hello');
```

Subpaths: `@phantom-agent-sdk/client/transcript` (the record's line format),
`@phantom-agent-sdk/client/systemPrompt` (the layout and the stored prompt).

**Lockstep.** Client and backend are one version: `BackendClient` reads the
backend's `sdk_version` from `GET /health` before its first request and
refuses a backend on another (`sdk_version_mismatch`). `src/sdkVersion.ts`
carries the number beside `package.json`; the build fails when they differ
(`../../scripts/assert-sdk-version.mjs`).

```
npm run sdk:build      # from the repo root
npm run sdk:lint
```
