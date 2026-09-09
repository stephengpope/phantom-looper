# core/ — shared by the app and the service

`/phantom-cli` and `/phantom-backend` both import `/core`. Nothing here
imports from either. Put code here when both sides need the same behavior:
an agent, a prompt, a transcript, a tool kit, a session open, an id.

```
session.ts        openSession — the one way anything obtains a session (below)
ids.ts            newId() lowercase ULID · idTime(id) — the mint time rides in the name
kanban.ts         DEFAULT_COLUMNS · checklist keys: newKey, normalizeKey, keyedItems
ndjson.ts         ndjson(body) — records off a streaming response; the server's stream shape
version.ts        REPO, parseVersion, isBehind, bare, checkLatest — shared by the cli and the server's upgrade checker
skills/skills.ts  scanSkills(root), mergeSkills, frontmatter parsing (splitFrontmatter, parseDescription, parseName)
skills/validate.ts the write-side rules a skill must pass; lintSkillMd warns only
llm/              agents, prompts, tools, transcript — own map
```

## openSession

Four steps, one code path, so lock behavior and prompt freezing cannot
differ between callers:

1. resolve: no id creates; an id whose files are gone restarts; an active
   id attaches.
2. lock, only when `lock: true`. Opening is reading. The looper and the
   turn route lock for the duration; the cli locks per turn.
3. pull the server transcript. It is the record; local copies are working
   memory.
4. the prompt: the header's `system_prompt` wins verbatim. Without one, it
   is assembled from the create response's skills, git facts, secrets and
   environment, and frozen by the first save.

`saveTranscript` starts the PUT and returns; saves chain in order.
`close()` awaits the chain, then releases the lock in a `finally`. A save
failure surfaces from `close()`.

Callers: `phantom-backend/looper/engine.ts`, `looper/turn.ts`,
`telegram/engine.ts`, `api/routes/sessions.ts`, `phantom-cli/App.tsx`.

## Checklist keys (kanban.ts)

An item's key is minted by the server on first write and never changes.
Random, not derived from the text, so a model cannot guess one; a key can
only be copied from a read or a write result. `normalizeKey` lowercases a
model's echo. `keyedItems` keeps caller keys, mints for new items, and
re-mints a duplicate.

## Skills

Two tiers, both server-side: the repo's `.agents/skills/` and the system
skills baked into the session image (`phantom-backend/systemSkills.ts`).
Repo wins a name collision. Identity is the folder name; the frontmatter
`name` is checked on write only. A skill with no parseable description is
skipped silently.

