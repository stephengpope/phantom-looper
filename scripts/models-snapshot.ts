// Write the model catalog snapshot from models.dev. Two callers:
//   the api image build (Dockerfile) — a fresh copy into dist/phantom-backend/,
//     so every release ships current without anyone remembering;
//   `npm run models:snapshot` — refreshes the committed phantom-backend/
//     models-snapshot.json a source run falls back on.
// Dies when models.dev does not answer: a stale list must never ship by accident.
import { writeSnapshot } from '../phantom-backend/models.js';

const out = process.argv[2];
const catalog = await writeSnapshot(out || undefined);
const n = Object.values(catalog).reduce((s, list) => s + list.length, 0);
console.log(`models snapshot: ${n} models → ${out ?? 'phantom-backend/models-snapshot.json'}`);
