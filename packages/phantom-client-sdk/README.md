# phantom-client-sdk

The agent runtime for a phantom-backend. A base class that knows how to run
an agent against the server; an app extends it with the agent's type and its
prompt. Everything else — the model, the tools, the conversation, the lock,
the record, the tokens, stopping — the runtime does by asking the server.

```
npm run sdk:build
npm run sdk:lint
```
