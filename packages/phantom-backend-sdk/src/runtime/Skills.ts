// Skills — Agent Skills folders in a workspace's repo (.agents/skills/
// <name>/), merged with the image's system tier (repo shadows). Stub.
export interface SkillMeta { name: string; description: string; tier: 'repo' | 'system'; files: string[] }
export type SkillChange =
  | { action: 'create' | 'edit'; name: string; content: string }
  | { action: 'patch'; name: string; oldString: string; newString: string; replaceAll?: boolean }
  | { action: 'delete'; name: string }
  | { action: 'writeFile' | 'removeFile'; name: string; filePath: string; fileContent?: string };

export class Skills {
  async list(workspaceId: string): Promise<SkillMeta[]> { throw stub(); }
  async load(workspaceId: string, name: string, file?: string): Promise<{ content: string; files: string[] }> { throw stub(); }
  /** Create, edit, patch, delete a repo skill or one of its files. Validated; a system skill is read-only. */
  async change(workspaceId: string, change: SkillChange): Promise<SkillMeta> { throw stub(); }
}
const stub = () => new Error('stub');
