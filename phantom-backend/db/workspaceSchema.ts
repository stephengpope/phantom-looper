// Per-workspace schema lifecycle. Each workspace gets `wsp_<id>` holding its
// board: `cards` + `card_revisions` (+ the revision trigger). N copies of these
// tables exist, so changes ship as versioned SQL applied per schema —
// phantom_looper.workspace_schema_state records where each workspace is.
// Never hand-edit production.
//
// The schema is system-owned: every write goes through the API routes.
import type pg from 'pg';
import { logger } from '../log.js';

const log = logger('workspace-schema');

/** Versioned migrations, applied in order per schema. %SCHEMA% is substituted;
 *  it derives from the workspace id (ULID: [0-9a-z], injection-inert), but
 *  quoting discipline is kept anyway. */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    // The board. Status is a plain string matched against the workspace's
    // column list (workspaces.kanban_columns, default in code) — columns are
    // data, not DDL. `auto_plan`/`auto_build` (v3) are the per-card looper
    // switches: null inherits the workspace setting of the same name. `requirements` is the ONE
    // checklist — {key, text, done}, done meaning VERIFIED.
    //
    // Revision history is a trigger, not route code, so any write path is
    // recorded. An update stores the OLD values of just the keys that changed;
    // a delete stores the whole card as it last stood.
    version: 1,
    sql: `
      create schema if not exists "%SCHEMA%";

      create sequence if not exists "%SCHEMA%".card_seq;
      create table if not exists "%SCHEMA%".cards (
        id             bigint generated always as identity primary key,
        seq            int not null default nextval('"%SCHEMA%".card_seq'),
        status         text not null default 'backlog',
        pos            real not null,
        title          text not null,
        details        text not null default '',
        user_story     text not null default '',
        requirements   jsonb not null default '[]'::jsonb,
        blocked_reason text,
        supervised     boolean,
        archived       boolean not null default false,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now()
      );
      create index if not exists cards_status_idx on "%SCHEMA%".cards (status) where not archived;

      create table if not exists "%SCHEMA%".card_revisions (
        id          bigint generated always as identity primary key,
        card_id     bigint not null,
        seq         int not null,
        op          text not null,
        changed     jsonb not null,
        changed_at  timestamptz not null default now()
      );
      create index if not exists card_revisions_seq_idx on "%SCHEMA%".card_revisions (seq);

      create or replace function "%SCHEMA%".record_card_revision() returns trigger
      language plpgsql
      set search_path = "%SCHEMA%"
      as $fn$
      declare diff jsonb;
      begin
        if tg_op = 'DELETE' then
          insert into card_revisions (card_id, seq, op, changed)
            values (old.id, old.seq, 'delete', to_jsonb(old));
          return old;
        end if;
        -- updated_at moves on every write; recording it would make every
        -- revision claim two changes.
        select jsonb_object_agg(e.key, e.value) into diff
          from jsonb_each(to_jsonb(old) - 'updated_at') e
          where to_jsonb(new) -> e.key is distinct from e.value;
        if diff is not null then
          insert into card_revisions (card_id, seq, op, changed)
            values (old.id, old.seq, 'update', diff);
        end if;
        return new;
      end
      $fn$;

      drop trigger if exists cards_revision on "%SCHEMA%".cards;
      create trigger cards_revision
        after update or delete on "%SCHEMA%".cards
        for each row execute function "%SCHEMA%".record_card_revision();
    `,
  },
  {
    // `resolution` — the human's reply to a block (the unblocker): the
    // supervisor writes blocked_reason, a person writes resolution and moves
    // the card back. Both ride the supervisor's briefing; the loop clears
    // both once the card moves on, so stale answers never haunt the next
    // block.
    version: 2,
    sql: `
      alter table "%SCHEMA%".cards add column if not exists resolution text;
    `,
  },
  {
    // The one `supervised` switch becomes two, one per loop column:
    // auto_plan gates `plan`, auto_build gates `in_progress` — each a
    // tri-state (null inherits the workspace setting of the same name). A
    // card's old value meant both, so it seeds both. The revision trigger
    // diffs whole rows (to_jsonb), so dropping the column needs no trigger
    // change; old revisions keep their `supervised` keys as history.
    version: 3,
    sql: `
      alter table "%SCHEMA%".cards add column if not exists auto_plan boolean;
      alter table "%SCHEMA%".cards add column if not exists auto_build boolean;
      update "%SCHEMA%".cards set auto_plan = supervised, auto_build = supervised
        where supervised is not null;
      alter table "%SCHEMA%".cards drop column if exists supervised;
    `,
  },
  {
    // `pinned` — the card sticks to the top of its column: pinned cards are
    // a group above the rest, pos still sorting inside the group. Plain
    // boolean, no inherit — a pin is a fact about one card.
    version: 4,
    sql: `
      alter table "%SCHEMA%".cards add column if not exists pinned boolean not null default false;
    `,
  },
];

export async function ensureWorkspaceSchema(pool: pg.Pool, workspaceId: string, schemaName: string): Promise<void> {
  const { rows } = await pool.query(
    'select version from phantom_looper.workspace_schema_state where workspace_id = $1', [workspaceId]);
  const current = rows[0]?.version ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await pool.query(m.sql.replaceAll('%SCHEMA%', schemaName));
    await pool.query(`
      insert into phantom_looper.workspace_schema_state (workspace_id, version) values ($1, $2)
      on conflict (workspace_id) do update set version = $2`, [workspaceId, m.version]);
    log.info({ schema: schemaName, version: m.version }, 'workspace schema migrated');
  }
}

/** Boot: bring every workspace schema to the current version. */
export async function migrateAllWorkspaceSchemas(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query('select id, schema_name from phantom_looper.workspaces');
  for (const r of rows) await ensureWorkspaceSchema(pool, r.id, r.schema_name);
}

export async function dropWorkspaceSchema(pool: pg.Pool, schemaName: string): Promise<void> {
  await pool.query(`drop schema if exists "${schemaName}" cascade`);
}
