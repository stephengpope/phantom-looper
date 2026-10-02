// The three agent types this app runs, registered through the agent-type
// door. The SDK ships no types: what a coder, a supervisor and an
// assistant ARE — which tools, which workspace relationship, whether their
// sessions show in lists — is said here and nowhere else.
import type { AgentTypeDefinition } from 'phantom-backend-sdk';

export const appAgentTypes: AgentTypeDefinition[] = [
  {
    // Writes code in its own checkout. Everything.
    name: 'coding',
    workspace: 'own',
    tools: ['files', 'tasks', 'skills', 'web', 'secrets', 'crons', 'database', 'board:read', 'notify'],
    listed: true,
  },
  {
    // Judges a card run: reads the coder's checkout, never writes it. Its
    // card-bound powers (move, items) are the looper's own tools, added per run.
    name: 'supervisor',
    workspace: 'borrow',
    tools: ['files:read', 'web', 'board:read'],
    listed: false,
  },
  {
    // The user's assistant: works the board and the sessions, reads the
    // files of whatever session is on screen.
    name: 'assistant',
    workspace: 'borrow',
    tools: ['files:read', 'web', 'crons', 'board', 'git'],
    listed: false,
  },
];
