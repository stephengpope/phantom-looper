# Maintenance on session runners: warm checkouts and disk cleanup

A plan. Not built.

## The problem

Two of the backend's maintenance jobs run only on the API's own machine. A
session runner never gets them:

1. **Warm checkouts** (`CheckoutPool.tick`): hosts never pre-clone. Every new
   session on a host is a full clone (`LocalHost.checkout` tries `claimSlot`,
   finds nothing, falls through to `cloneFresh`). Nothing is refreshed or
   trimmed there either.
2. **Disk cleanup** (`pressureSweep` → `diskCleanup`): a host's disk is never
   measured and never freed. It fills until the placement floor
   (`MIN_FREE_GB`, docs/host-load-placement.md) takes it out of the running,
   and stays out. Old session images are never pruned there either.

Both sit behind `runsContainers` — `PhantomBackend.#startLoops` and
`Disk.pressureSweep` — a flag that means "this box runs containers", written
before hosts existed. The other maintenance jobs (container reap, work-state
refresh, instant sync) already reach hosts through `hosts.of()`.

## The shape

The pattern the rest of the system uses: the **timer stays on the API**, the
**work runs on the host** as a job down its feed. A host reads no database
and holds no settings; every job carries what it needs.

### 1. Warm checkouts — one job, run on the host

On each maintenance tick the API sends every online host:

```
{ type: 'poolTick', projects: [{ id, baseBranch, owner, name, auth, target, refreshMs, maxAgeMs }] }
```

The host runs the existing tick body — stale setup slots, slots for projects
no longer served, evict past `maxAgeMs`, refresh past `refreshMs`, restock
one per project — against its own volume. `tick(projects, settings, paths)`
becomes `tick(facts, paths)`; the API resolves the facts and calls the same
function on itself. The module-level `ticking` flag is per process, so a
host's tick and the API's never collide.

`auth` is the project's git token. A checkout job already carries it to the
host that runs the checkout; what is new is that a host receives tokens for
projects nobody has opened there yet. **Rule: a host is stocked only for
projects that have had a workspace on it before** (one query on
`workspaces.session_runner_id`). A fresh host stocks nothing until its first
session; from then on that project is warm there.

### 2. Disk cleanup — decisions on the API, deletion on the host

`diskCleanup` already separates deciding from doing. The decisions need the
database (which sessions are on this host, `lastUsedAt`, busy, landed on
base, backup first) and credentialed git (`backup`, `landed`) — the API's.
Only three things are the host's: measuring, pruning old images, and the
removal itself.

`pressureSweep` runs once per host — the API's own disk and every online
host — with the deps bound to that host:

- `measure`: the host's last heartbeat `load` (`freeGB`, `usedPct`), or a
  `disk` job (exists) when a fresh number matters.
- `owners`: sessions whose workspace is placed on this host (`hostIdOf`),
  instead of today's "placed on none".
- `landed`: `hosts.of(session).repo(...)` — the work-state read already goes
  through the host.
- `removeOldImages`: **one new job**, `removeOldImages { keep: [...] }`,
  the host running `Images.removeOlderThan` on its own daemon.
- `deleteSession` / `backup`: unchanged — `sessionContainers.remove` and
  `sessions.destroy` already route through `hosts.of()`.

No credential leaves the API for this half.

## Cost

Two new job types (`poolTick`, `removeOldImages`), one signature change
(`tick`), the sweep looped over hosts, the host-side `case` for each.
About 120 lines. `maintenance_interval_ms` × N hosts = N small jobs a minute.

## Open

- Whether `poolTick` should wait for the host's previous one (a slow clone
  outlasting the interval). Proposed: the host's `ticking` flag drops it, as
  it does on the API today.
- A heartbeat `load` is up to 15 s old. Fine for "is it over the line"; the
  sweep re-measures per deletion today, which on a host means a `disk` job
  per deletion. Accepted.
