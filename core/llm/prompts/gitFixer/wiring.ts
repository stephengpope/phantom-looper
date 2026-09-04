// The Git Fixer's wiring — fills ./gitFixer.ts (the document).
import { fill } from '../template.js';
import { SYSTEM, FIRST_MESSAGE_RECOVER, COMMIT_MESSAGE } from './gitFixer.js';

export function systemPrompt(branch: string, sessionId: string): string {
  return fill(SYSTEM, { branch, sessionId });
}

export const toGitFixer = {
  recover: (branch: string) => fill(FIRST_MESSAGE_RECOVER, { branch }),
};

export const commitMessagePrompt = (stat: string, diff: string) =>
  fill(COMMIT_MESSAGE, { stat, diff });
