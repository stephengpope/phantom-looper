// System skills — the MACHINE tier: `/opt/skills/<name>/SKILL.md` baked into
// the workspace (fs) image, documenting the toolchain that image carries
// (playwright-cli first). Two tiers exist: the repo's `.agents/skills/`
// (scanned host-side over the checkout) and this one; repo shadows system on
// a name collision, same rule as settings resolution — most specific wins.
//
// The image is read WITHOUT running anything: a container is created (never
// started) and `/opt/skills` is pulled out as a filesystem archive, so a
// custom container_image needs no cooperation beyond optionally shipping the
// directory. The whole tree is cached by image ID — the skills ship IN the
// image, so the ID is the content. Every failure — image not present yet
// (first session on a fresh box pulls at container create, later than this),
// no /opt/skills, docker down — is an EMPTY tier, logged, never an error:
// skills fail open like settings stocking, and the live skill_list heals the
// prompt-time miss.
import type Docker from 'dockerode';
import { extract } from 'tar-stream';
import { parseDescription, type SkillMeta } from '../core/skills/skills.js';
import { logger, errStr } from './log.js';

const log = logger('systemSkills');

export const SYSTEM_SKILLS_DIR = '/opt/skills';
const MAX_FILE_BYTES = 512 * 1024; // one bundled reference, not an asset store
const MAX_TREE_BYTES = 8 * 1024 * 1024;

export interface SystemSkill {
  name: string;
  /** SKILL.md, whole. */
  md: string;
  /** Bundled files (references/… etc.), path → content. */
  files: Map<string, string>;
}
export type SystemSkillTree = Map<string, SystemSkill>;

const cache = new Map<string, SystemSkillTree>();

/** The image's `/opt/skills` as a tree, cached by image ID. Never throws. */
export async function systemSkillTree(docker: Docker, image: string): Promise<SystemSkillTree> {
  let id: string;
  try {
    id = (await docker.getImage(image).inspect()).Id;
  } catch (e) {
    log.info({ image, err: errStr(e) }, 'system skills: image not inspectable — empty tier');
    return new Map();
  }
  const hit = cache.get(id);
  if (hit) return hit;
  let tree: SystemSkillTree;
  try {
    tree = await readTree(docker, image);
  } catch (e) {
    log.warn({ image, err: errStr(e) }, 'system skills: read failed — empty tier');
    tree = new Map();
  }
  cache.set(id, tree);
  return tree;
}

/** The tier as prompt-ready metas: every skill whose SKILL.md has a
 *  description, sorted — the same lenient discovery rule as scanSkills. */
export async function systemSkills(docker: Docker, image: string): Promise<SkillMeta[]> {
  const tree = await systemSkillTree(docker, image);
  const out: SkillMeta[] = [];
  for (const [name, s] of tree) {
    const description = parseDescription(s.md);
    if (description) out.push({ name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readTree(docker: Docker, image: string): Promise<SystemSkillTree> {
  // Created, never started: getArchive reads the image's filesystem through
  // the container handle, and `remove` leaves nothing behind.
  const container = await docker.createContainer({
    Image: image, Cmd: ['true'], HostConfig: { NetworkMode: 'none' },
  });
  try {
    const stream = await container.getArchive({ path: SYSTEM_SKILLS_DIR });
    return await parseTar(stream);
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** Entries arrive as `skills/<name>/<path>` (the archive is rooted at the
 *  requested directory's basename). Only regular files are kept, size-capped;
 *  anything outside `<name>/…` (the root dir itself) is skipped. */
function parseTar(stream: NodeJS.ReadableStream): Promise<SystemSkillTree> {
  return new Promise((resolve, reject) => {
    const tree: SystemSkillTree = new Map();
    let total = 0;
    const ex = extract();
    ex.on('entry', (header, content, next) => {
      const parts = header.name.split('/').filter(Boolean).slice(1); // drop 'skills/'
      const skill = parts[0];
      const rel = parts.slice(1).join('/');
      if (header.type !== 'file' || !skill || !rel
        || header.size! > MAX_FILE_BYTES || total > MAX_TREE_BYTES) {
        content.resume();
        return void content.on('end', next);
      }
      const chunks: Buffer[] = [];
      content.on('data', (d: Buffer) => { chunks.push(d); total += d.length; });
      content.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let s = tree.get(skill);
        if (!s) { s = { name: skill, md: '', files: new Map() }; tree.set(skill, s); }
        if (rel === 'SKILL.md') s.md = text; else s.files.set(rel, text);
        next();
      });
      content.on('error', reject);
    });
    ex.on('finish', () => {
      // A folder with no SKILL.md is not a skill.
      for (const [name, s] of tree) if (!s.md) tree.delete(name);
      resolve(tree);
    });
    ex.on('error', reject);
    stream.on('error', reject);
    stream.pipe(ex);
  });
}
