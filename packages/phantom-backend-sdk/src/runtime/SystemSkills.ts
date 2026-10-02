// SystemSkills — the MACHINE tier: /opt/skills/<name>/SKILL.md baked into
// the workspace image, read once per image. Stub.
import type { SkillMeta } from './Skills.js';
export class SystemSkills {
  async listIn(image: string): Promise<SkillMeta[]> { throw stub(); }
  async readIn(image: string, name: string, file?: string): Promise<string> { throw stub(); }
}
const stub = () => new Error('stub');
