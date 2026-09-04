// The Git Fixer — git auto-push's conflict resolver — in one place: its
// prompt stack and its kit.
//
// Prompt: the Git Fixer sections, parameterised by branch and session trailer.
// Assembled fresh per run — a Git Fixer run is one conversation, nothing
// frozen.
//
// Kit: server — `bash` (fixerBashTool), backed by whatever the caller uses to
// run a command in the workspace container. No reasoning is set: the Git
// Fixer is bounded by steps and wall-clock, not by how much it thinks.
import { createAgent, type Agent, type ModelConfig } from '../createAgent.js';
import { systemPrompt, toGitFixer } from '../prompts/gitFixer/wiring.js';
import { fixerBashTool, type ContainerExec } from '../tools/server.js';

export { toGitFixer };

export function gitFixerInstructions(branch: string, sessionId: string): string {
  return systemPrompt(branch, sessionId);
}

export function gitFixerAgent(model: ModelConfig, exec: ContainerExec, branch: string, sessionId: string): Agent {
  return createAgent(model, {
    instructions: gitFixerInstructions(branch, sessionId),
    tools: fixerBashTool(exec),
    maxSteps: 40,
  });
}
