# Placing by load: CPU and disk, not file counts

A proposal. Not built.

## Today

Placement (host/SessionHosts.ts `place`) picks a tier — the user's own hosts,
then shared hosts, then the server — and inside a tier orders by the number
of workspaces with files on disk, then by most recent connection. The count
is a proxy: a host with two idle checkouts and a host with two agents
compiling look the same, and a host with 5 GB free looks like one with 500.

## Proposal

The host heartbeats up its relay every 15 s already (`{ type: 'heartbeat' }`).
Put the box's load on that beat:

```
{ type: 'heartbeat', load: { cpu: 0.37, freeGB: 212, usedPct: 54, running: 3 } }
```

- `cpu`: the one-minute load average over the CPU count (`os.loadavg()[0] /
  os.cpus().length`), so 1.0 is "every core busy". Cheap, host-wide, honest
  about agents compiling in their containers.
- `freeGB`, `usedPct`: `LocalHost.disk()` — statfs of the workspace volume.
- `running`: running session containers, `LocalHost.activeWorkspaces().length`.

The backend keeps the last beat per host in memory (RemoteHost) and shows it
on `GET /api/session-hosts` and in `phantom-cli host status`.

## The rule

Tiers stay. Inside a tier:

1. Drop any host under the disk floor — `MIN_FREE_GB` (30), the same floor
   the disk sweep uses — or over `disk_cleanup_percent`. A host that cannot
   take a checkout is not a candidate.
2. Order by fewest `running` containers.
3. Then by lowest `cpu`.
4. Then the old tie-breaks: fewest workspaces with files, most recently
   connected.

A host whose last beat is older than 45 s is offline and already excluded.

## Why this order

Running containers is the fairest first cut: it counts agents, not
checkouts, and it is exact. CPU breaks ties between hosts with the same
count — a box of idle agents beats a box of compiling ones. File counts stay
only as the last word, because a host with more checkouts has more to sweep.

## Cost

One field on the heartbeat, one memory slot per host, a dozen lines in
`place`, the status line. No schema change: load is live state, not a fact
worth a row.

## Open

- Whether a user's own host should ever be skipped for a shared one on load.
  Proposed: no. A user host is theirs; load only orders among their own.
- A tool-call ceiling for an offline host (give up after N minutes with a
  retryable `host_offline`) is a separate decision, noted here because the
  same beat is what proves a host alive.
