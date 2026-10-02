// Write the model catalog snapshot from models.dev. Two callers:
//   the api image build (Dockerfile) — a fresh copy into the backend SDK's
//     dist/, so every release ships current without anyone remembering;
//   `npm run models:snapshot` — refreshes the committed snapshot a source
//     run falls back on.
// Dies when models.dev does not answer: a stale list must never ship by accident.
import { writeSnapshot } from 'phantom-backend-sdk';

const out = process.argv[2];
const catalog = await writeSnapshot(out || undefined);
const count = Object.values(catalog).reduce((sum, list) => sum + list.length, 0);
console.log(`models snapshot: ${count} models → ${out ?? 'packages/phantom-backend-sdk/src/agents/models-snapshot.json'}`);
