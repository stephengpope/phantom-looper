// The SQL runner the agent's play space and `Database.queryAs` share: a
// caller's statements on one connection, one result per statement with the
// first `limit` rows and the true row count, Postgres's own words on a
// refusal. Rows are read as they stream and dropped past `limit`, so the
// server never holds a result bigger than what was asked for; rows come
// back as arrays with the field list, so a duplicate column name is
// refused instead of silently overwriting.
import pg from 'pg';
import { parse as parseArray } from 'postgres-array';

export interface StatementResult {
  /** Postgres's command tag: SELECT, INSERT, CREATE TABLE, ... */
  command: string;
  /** The TRUE count Postgres reports for the statement — every row a select
   *  matched, or every row a write touched — whatever `rows` carries. */
  rowCount: number | null;
  /** The first `limit` rows the agent asked for. */
  rows: Record<string, unknown>[];
}

/** What the agent asks for, per call. */
export interface QueryOptions {
  /** Rows returned per statement; rowCount is always the true total. */
  limit: number;
  /** Longest cell kept whole; past it the cell ends in `…[truncated, N chars]`. */
  maxCellChars: number;
  /** Values for $1…$n. Postgres allows them with ONE statement only. */
  params?: unknown[];
}

/** Where a statement failed, when Postgres says (parse errors do; runtime
 *  errors name the object instead — see SqlError). */
export interface SqlErrorLocation { line: number; column: number; text: string }

/** Postgres refused the agent's SQL. The message is Postgres's own — the
 *  agent needs it verbatim to fix the statement. The call was ONE transaction,
 *  so nothing in it was applied. */
export class SqlError extends Error {
  constructor(message: string, readonly info: {
    code?: string; detail?: string; hint?: string;
    table?: string; column?: string; constraint?: string;
    at?: SqlErrorLocation;
  }) {
    super(message);
  }
}

/** A 1-based character offset (Postgres's `position`) as line, column and
 *  the line's text. */
export function locate(sql: string, position: string): SqlErrorLocation {
  const offset = Math.max(0, Number(position) - 1);
  const before = sql.slice(0, offset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = sql.indexOf('\n', offset);
  return { line, column: offset - lineStart + 1, text: sql.slice(lineStart, lineEnd < 0 ? undefined : lineEnd) };
}

/** How values come back to the agent — the driver's defaults leak Node
 *  shapes (bigint as string, date and zoneless timestamp as a Z-stamped
 *  timestamp, bytea as a Buffer object, interval as an object). Each
 *  override applies to the type's array too. Scoped to the agent's
 *  connection: our own pool keeps its own. */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const asIs = (value: string) => value;
/** A number when exact, the digits otherwise — never a wrong number. */
const bigint = (value: string) => { const b = BigInt(value); return b <= SAFE && b >= -SAFE ? Number(b) : value; };
const TYPES = pg.types.builtins;
// element OID -> [parser, array OID]. Postgres's text is kept where the
// driver's parse would add a claim the value never made (a zone) or a shape
// nobody asked for.
const OVERRIDES: Record<number, [(value: string) => unknown, number]> = {
  [TYPES.INT8]: [bigint, 1016],
  [TYPES.DATE]: [asIs, 1182],       // YYYY-MM-DD
  [TYPES.BYTEA]: [asIs, 1001],      // \x hex
  [TYPES.TIMESTAMP]: [asIs, 1115],  // no zone, so no Z: "2026-09-19 20:11:51.051"
  [TYPES.INTERVAL]: [asIs, 1187],   // "1 day 02:00:00"
};
const ARRAY_OF = Object.fromEntries(Object.entries(OVERRIDES).map(([oid, [parse, arr]]) => [arr, parse])) as
  Record<number, (value: string) => unknown>;
export const AGENT_TYPES: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) => {
    if (format === 'binary') return pg.types.getTypeParser(oid, format);
    if (OVERRIDES[oid]) return OVERRIDES[oid][0];
    const elementParser = ARRAY_OF[oid];
    if (elementParser) return (text: string) => parseArray(text, elementParser);
    return pg.types.getTypeParser(oid, format);
  },
};

/** The cell the agent sees: strings past the cap end in the true length. */
function cell(value: unknown, maxCellChars: number): unknown {
  if (typeof value === 'string' && value.length > maxCellChars) return `${value.slice(0, maxCellChars)}…[truncated, ${value.length} chars]`;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const json = JSON.stringify(value);
    if (json.length > maxCellChars) return `${json.slice(0, maxCellChars)}…[truncated, ${json.length} chars]`;
  }
  return value;
}


/** Run `sql` on `client`. No parameters => the simple query protocol,
 *  which is what allows several statements in one text (one implicit
 *  transaction). With parameters Postgres takes exactly one statement. */
export async function runStatements(client: pg.Client, sql: string, options: QueryOptions): Promise<StatementResult[]> {
  try {
    // A `row` listener makes pg hand each row over instead of accumulating
    // it; the result object identifies which statement the row belongs to.
    const kept = new Map<pg.Result, unknown[][]>();
    const results = await new Promise<pg.Result[]>((resolve, reject) => {
      const config: pg.QueryArrayConfig = { text: sql, values: options.params, rowMode: 'array' };
      const query = new pg.Query(config);
      query.on('row', (row, result) => {
        if (!result) return;
        const rows = kept.get(result) ?? [];
        if (rows.length < options.limit) rows.push(row as unknown[]);
        kept.set(result, rows);
      });
      query.on('end', (results) => resolve(Array.isArray(results) ? results : [results]));
      query.on('error', reject);
      client.query(query);
    });
    return results.map((result) => {
      const names = result.fields.map((field) => field.name);
      const dup = names.find((name, i) => names.indexOf(name) !== i);
      if (dup) throw new SqlError(`duplicate column name "${dup}" — alias one of them so both values come back`, {});
      const rows = (kept.get(result) ?? []).map((row) =>
        Object.fromEntries(names.map((name, i) => [name, cell(row[i], options.maxCellChars)])));
      return { command: result.command, rowCount: result.rowCount, rows };
    });
  } catch (error) {
    if (error instanceof SqlError) throw error;
    const pgError = error as { message: string; code?: string; detail?: string; hint?: string; position?: string;
      table?: string; column?: string; constraint?: string };
    // Postgres errors carry a SQLSTATE; anything else (connection) is ours.
    if (!pgError.code) throw error;
    throw new SqlError(pgError.message, {
      code: pgError.code, detail: pgError.detail, hint: pgError.hint,
      table: pgError.table, column: pgError.column, constraint: pgError.constraint,
      at: pgError.position ? locate(sql, pgError.position) : undefined,
    });
  }
}
