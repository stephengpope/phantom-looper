# Placing by load: CPU, not file counts

Built: `SessionHosts.place`, the heartbeat in `SessionHost`, `RemoteHost.load`.

## Before

Placement (host/SessionHosts.ts `place`) picked a tier — the user's own hosts,
then shared hosts, then the server — and inside a tier ordered by the number
of workspaces with files on disk, then by most recent connection. The count
was a proxy: a host with two idle checkouts and a host with two agents
compiling looked the same, and a host with 5 GB free looked like one with 500.

## Now

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

1. **Disk is a filter, not an order.** A host under `MIN_FREE_GB` (30, the
   floor the disk sweep uses) or over `disk_cleanup_percent` is not a
   candidate. A host that cannot take a checkout is not in the running.
2. **Lowest `cpu` wins.** The only ordering.
3. **Equal `cpu`: one at random.**

A host whose last beat is older than 45 s is offline and already excluded.
A host online but not yet beaten (the first 15 s) reads as idle.

`running` and the file count play no part in placement: CPU already says
what running agents cost (an idle container costs nothing), and a count
would only double-count it with less information. Both stay on the beat
for the status line.

## Known lag

The load average is a one-minute average: a host handed a session still
reads idle for a while, so a burst of placements can land on one box. The
random pick spreads a burst among hosts that read equal; it does not spread
one across hosts that read different. Accepted — the next beat corrects it,
and one wrong pick costs a slow minute, not a lost session.

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
