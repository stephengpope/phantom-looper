// The file-watcher child — @parcel/watcher runs HERE, in its own process,
// never in the API. Its inotify backend dies on EINTR ("Interrupted system
// call": a signal landing while it waits in poll()) and cannot be revived —
// upstream issue #141, open since 2023. In the API process, with its HTTP
// server, database pool, container management and timers all generating
// signals, that is a matter of time, and one death silently ended instant
// sync for the folder. A process that does nothing but watch sees almost
// none of that traffic; when it does die, FolderWatcher (the parent) forks
// a new one and replays every watch. Same pattern VS Code uses with this
// same library.
//
// Protocol, over fork()'s IPC channel:
//   parent -> child  { op: 'watch', id, dir } | { op: 'unwatch', id }
//   child  -> parent { op: 'changed', id }
// A watcher error is fatal by design: exit, and let the parent start over.
import watcher, { type AsyncSubscription } from '@parcel/watcher';

/** Git's own writes are not watched — every sync would trigger itself.
 *  node_modules is thousands of directories per checkout (one kernel watch
 *  each) that no sync ever lands. Globs, so nested ones (a monorepo's
 *  packages/x/node_modules) are pruned too — a plain path only matches
 *  the top level (verified: 525 watches vs 24 on a test tree). */
const IGNORE = ['**/.git', '**/node_modules'];

type Message = { op: 'watch'; id: string; dir: string } | { op: 'unwatch'; id: string };

const subscriptions = new Map<string, AsyncSubscription>();

process.on('message', async (m: Message) => {
  if (m.op === 'watch') {
    if (subscriptions.has(m.id)) return;
    const sub = await watcher.subscribe(m.dir, (err, events) => {
      if (err) {
        process.stderr.write(`watcher error on ${m.id}: ${err.message}\n`);
        process.exit(1);
      }
      if (events.length) process.send?.({ op: 'changed', id: m.id });
    }, { ignore: IGNORE });
    subscriptions.set(m.id, sub);
  } else if (m.op === 'unwatch') {
    const sub = subscriptions.get(m.id);
    subscriptions.delete(m.id);
    await sub?.unsubscribe();
  }
});

// The parent is gone: nothing to report to, so no reason to exist.
process.on('disconnect', () => process.exit(0));
