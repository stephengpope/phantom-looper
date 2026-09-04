// core/skills — the pure core: the .agents/skills scanner and the validators.
// Plain filesystem in a temp dir; no Docker, no Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SKILLS_DIR, mergeSkills, parseDescription, parseName, scanSkills,
} from '../core/skills/skills.js';
import {
  lintSkillMd, validateFilePath, validateSkillMd, validateSkillName,
} from '../core/skills/validate.js';

const md = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function root(): string {
  return mkdtempSync(join(tmpdir(), 'phantom-skills-'));
}

function addSkill(r: string, name: string, content: string) {
  const dir = join(r, SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

test('scan: one level of .agents/skills, description required, sorted, missing root = empty', async () => {
  const r = root();
  assert.deepEqual(await scanSkills(r), [], 'no .agents/skills yet');
  addSkill(r, 'zeta', md('zeta', 'Last alphabetically.'));
  addSkill(r, 'alpha', md('alpha', 'First alphabetically.'));
  addSkill(r, 'no-desc', '---\nname: no-desc\n---\n\nbody\n');
  // a stray file (not a folder) at the root is ignored
  writeFileSync(join(r, SKILLS_DIR, 'README.md'), 'not a skill');
  const skills = await scanSkills(r);
  assert.deepEqual(skills.map((s) => s.name), ['alpha', 'zeta'], 'sorted; no-desc skipped');
  assert.equal(skills[0].description, 'First alphabetically.');
});

test('scan: identity is the FOLDER name even when frontmatter disagrees (lenient, pi\'s rule)', async () => {
  const r = root();
  addSkill(r, 'folder-name', md('other-name', 'A hand-authored mismatch.'));
  assert.deepEqual((await scanSkills(r)).map((s) => s.name), ['folder-name']);
});

test('frontmatter: BOM tolerated, block-scalar descriptions flattened, quotes stripped', () => {
  assert.equal(parseDescription('﻿---\nname: x\ndescription: "quoted"\n---\nbody'), 'quoted');
  const block = '---\nname: x\ndescription: |\n  Line one\n  line two.\nlicense: MIT\n---\nbody';
  assert.equal(parseDescription(block), 'Line one line two.');
  assert.equal(parseName(block), 'x');
  assert.equal(parseDescription('no frontmatter at all'), null);
});

test('merge: earlier list wins a name collision (repo over personal), result sorted', () => {
  const repo = [{ name: 'deploy', description: 'repo version' }];
  const personal = [{ name: 'deploy', description: 'personal version' }, { name: 'audit', description: 'p' }];
  const merged = mergeSkills(repo, personal);
  assert.deepEqual(merged.map((s) => [s.name, s.description]),
    [['audit', 'p'], ['deploy', 'repo version']]);
});

test('validate: the spec name rule', () => {
  assert.equal(validateSkillName('pdf-tools'), null);
  for (const bad of ['', 'PDF', 'a--b', '-a', 'a-', 'a b', 'a_b', 'x'.repeat(65)]) {
    assert.ok(validateSkillName(bad), `'${bad}' is refused`);
  }
});

test('validate: SKILL.md needs a fence, a matching name, a description in budget, a body', () => {
  assert.equal(validateSkillMd('good', md('good', 'What it does and when.')), null);
  assert.match(validateSkillMd('x', 'no fence') ?? '', /frontmatter/);
  assert.match(validateSkillMd('x', md('y', 'd')) ?? '', /must match/);
  assert.match(validateSkillMd('x', '---\ndescription: d\n---\nbody') ?? '', /'name'/);
  assert.match(validateSkillMd('x', md('x', 'd'.repeat(1025))) ?? '', /description exceeds/);
  assert.match(validateSkillMd('x', '---\nname: x\ndescription: d\n---\n  \n') ?? '', /body/);
  assert.match(validateSkillMd('x', md('x', 'd', 'b'.repeat(100_001))) ?? '', /exceeds/);
});

test('validate: bundled-file paths stay under the four subdirs, no dot-dot', () => {
  assert.equal(validateFilePath('references/api.md'), null);
  assert.equal(validateFilePath('scripts/run.sh'), null);
  assert.match(validateFilePath('') ?? '', /required/);
  assert.match(validateFilePath('../../etc/passwd') ?? '', /\.\./);
  assert.match(validateFilePath('SKILL.md') ?? '', /must be under/);
  assert.match(validateFilePath('references/a;rm.sh') ?? '', /invalid characters/);
});

test('lint: advisory only — short description and links to bundled files', () => {
  const w = lintSkillMd(md('x', 'short', 'See [ref](references/api.md).'));
  assert.equal(w.length, 2);
  assert.match(w[0], /very short/);
  assert.match(w[1], /references\/api\.md/);
  assert.deepEqual(lintSkillMd(md('x', 'A real description of what and when to use it.')), []);
});
