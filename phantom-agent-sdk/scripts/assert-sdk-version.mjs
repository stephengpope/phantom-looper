// The lockstep rule's build gate. Each SDK package carries its version in
// two places on purpose — package.json (what npm publishes) and
// src/sdkVersion.ts (what the code reports and compares at runtime; a
// constant because the client is bundled into the cli, where no
// package.json rides along). This script fails the build when the two
// disagree, and when the two packages disagree with each other: client and
// backend are ONE version (docs/v1-plan.md §3).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');
const versions = ['client', 'backend'].map((name) => {
  const dir = join(root, name);
  const packaged = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  const inCode = /SDK_VERSION = '([^']+)'/.exec(readFileSync(join(dir, 'src', 'sdkVersion.ts'), 'utf8'))?.[1];
  if (packaged !== inCode) {
    console.error(`@phantom-agent-sdk/${name}: package.json says ${packaged}, src/sdkVersion.ts says ${inCode} — they must match`);
    process.exit(1);
  }
  return packaged;
});
if (versions[0] !== versions[1]) {
  console.error(`@phantom-agent-sdk/client is ${versions[0]}, @phantom-agent-sdk/backend is ${versions[1]} — the two are one version`);
  process.exit(1);
}
