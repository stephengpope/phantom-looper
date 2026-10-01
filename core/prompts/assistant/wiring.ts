// The Assistant's wiring — fills ./assistant.ts (the document).
import { fill } from '../template.js';
import { STAKEHOLDERS } from '../stakeholders.js';
import { VALUES } from '../values.js';
import { GIT } from '../git.js';
import { SENDING_FILES } from '../sending.js';
import { SYSTEM } from './assistant.js';

export function systemPrompt(): string {
  return fill(SYSTEM, { stakeholders: STAKEHOLDERS, values: VALUES, git: GIT, sending: SENDING_FILES });
}
