# test/ — the server suites

Real git, real Postgres, real containers. The fakes are boundary servers a
seam points at: a tiny GitHub in `phase4.test.ts` (`GITHUB_API_BASE`), a
tiny Firecrawl in `web.test.ts` (`FIRECRAWL_API_BASE`), and the model
scripted at the wire through createAgent's `fetch` seam (`ctx.modelFetch`).

```
npm test            unit · llm · skills · deploy · session · looper-logic · telegram · models — no Docker, no Postgres
npm run test:all    test/*.test.ts serially — PRE-RELEASE ONLY (10+ minutes of containers and Postgres)
npm run test:down   remove the shared Postgres container
```

## The one rule

Tests check what the code DOES — the data it stores, the messages it sends,
the rules it enforces — never what the screen looks like. A test that
compares the rendered screen breaks every time someone deliberately improves
the layout, so it cries wolf until nobody trusts any failure. And main stays
green: a commit that breaks a test fixes or deletes that test in the same
commit. A red suite is noise — every later failure costs detective work to
tell "was already broken" from "I broke it".

`tsx --test`, untyped. Node's runner silently ignores a listed file that
does not exist, so adding a suite means adding it to the `test` script in
package.json. `--test-concurrency=1` only on `test:all`; the Docker suites
share one Postgres and one daemon.

```
harness.ts             testDb(name) — a fresh database in the shared Postgres (phantom-test-pg, port 55432, tmpfs,
                       left running between runs); ensureWorkspaceImage (alpine + ripgrep + git); testRoot (/tmp, the
                       one hand-named path, because Docker Desktop shares it); git(); setWorkspaceSetting
unit.test.ts           pure server pieces: URL policy, crypto, ids, classifyGitFailure, clone depth, localState, pool claim,
                       the titler's rules, composeFacts, the tasks helpers
llm.test.ts            core/llm without a network: createAgent on a capturing fetch, the prompt stack, every kit, the cascade,
                       the thinking rule, the transcript format
skills.test.ts         core/skills on a temp dir
deploy.test.ts         host-artifact rules (see scripts/CLAUDE.md)
session.test.ts        core openSession on a scripted ApiCall
looper-logic.test.ts   every rule in looper/logic.ts and the loop-bound tools
telegram.test.ts       entities, attachments, media tags, approvals, menus, alerts
models.test.ts         the catalog
integration.test.ts    auth, settings layers, workspaces, session create/restart/destroy, the pool, GET /sessions
phase2.test.ts         every tool through a real container, fuzzy edit, images, the kill paths, /skills
phase3.test.ts         bash timeout, manual push and pull, detached commands, /tasks
phase4.test.ts         the Git Fixer, auto-push and auto-pull on real origins, the GitHub fake
kanban.test.ts         the card routes, item keys, the auto switches, auto-push on archive, the board GET
transcripts.test.ts    the record and the lock, token usage, titles, plan mode, list filters and pages
looper.test.ts         the loop end to end with tool_use, the session feed, the relay, the hold, the turn route
e2e-auto-push.test.ts  a card walks plan → in_progress → done with a real checkout, then archive auto-pushes to base
dind.test.ts           docker inside the workspace container; skips where a nested dockerd cannot run
web.test.ts            /web over the Firecrawl fake
secrets.test.ts        the secret namespace and /secrets
```

## The scripted wire

Every server-side turn streams, so a scripted step with a tool must ride
the SSE branch as a `tool_use` block; on the JSON branch a scripted move
silently never happens. The seat discriminator is structural: the
supervisor's request is the one carrying `kanban_card_move`. Loop messages
are matched on the templates' frozen first lines (`firstLine.*` from
`core/llm/prompts/supervisor/wiring.ts`), never on prose. Session-title
calls fire on every transcript save and are answered out of band, keyed
on the titler system prompt's first words, or one eats a scripted step.

Scripted models use a real model id (`claude-fable-5`); the thinking rule
keys off the id.

## Harness rules

- Origins are local bare repos over `file://`; the guarded git path runs
  for real with no token.
- `migrate(pool, { upTo })` tests a pre-migration state.
- Workspace overrides are rows at the workspace scope, written through
  `setWorkspaceSetting`.
- Ownership assertions pass on macOS because VirtioFS squashes uids; they
  mean something only on Linux.
