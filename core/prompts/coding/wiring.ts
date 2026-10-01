// The coding agent's wiring — the code that fills ./coding.ts (the
// document) with the shared agent texts. No prompt text lives here. What
// comes out is the agent's own words; the server's blocks are named in the
// layout (core/agents/coding.ts) and filled there.
import { fill } from '../template.js';
import { STAKEHOLDERS } from '../stakeholders.js';
import { VALUES } from '../values.js';
import { COMMUNICATION } from '../communication.js';
import { ENVIRONMENT } from '../environment.js';
import { SENDING_FILES } from '../sending.js';
import { CODING_AGENT, CODING_GIT, CODING_ENVIRONMENT, CODING_SENDING } from './coding.js';

/** The stable section's text: the agent itself. */
export const codingAgentText = (): string =>
  fill(CODING_AGENT, { stakeholders: STAKEHOLDERS, values: VALUES, communication: COMMUNICATION });

/** The context section's texts, in layout order. */
export const codingGitText = (): string => CODING_GIT;
export const codingEnvironmentText = (): string => fill(CODING_ENVIRONMENT, { environment: ENVIRONMENT });
export const codingSendingText = (): string => fill(CODING_SENDING, { sending: SENDING_FILES });
