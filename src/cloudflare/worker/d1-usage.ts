import { D1_USAGE_HEADER, parseD1Usage, type D1Usage } from '@/protocol/d1-usage';
import type { Env } from './types';

/** In-memory accounting of returned billing metadata; never queries or writes a log table. */
export function meterD1Usage(database: D1Database) {
  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0, complete: true };
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function add(value?: D1Usage) {
    if (!value) { usage.complete = false; return; }
    usage.rowsRead += value.rowsRead;
    usage.rowsWritten += value.rowsWritten;
    usage.complete &&= value.complete;
  }
  function record<T>(result: T): T {
    const meta = (result as { meta?: { rows_read?: number; rows_written?: number } } | null)?.meta;
    add(parseD1Usage(`${meta?.rows_read}:${meta?.rows_written}:1`));
    return result;
  }
  async function execute<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { usage.complete = false; throw error; }
  }
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      run: () => execute(async () => record(await statement.run())),
      all: <T>() => execute(async () => record(await statement.all<T>())),
      // D1 first() executes the query without adding LIMIT and discards metadata.
      // Select the same first row from all() so we can retain its billing counters.
      first: <T>() => execute(async () => record(await statement.all<T>()).results[0] ?? null),
    };
    statements.set(wrapped, statement);
    return wrapped;
  }
  const db: D1Database = {
    prepare: sql => wrap(database.prepare(sql)),
    batch: <T>(batch: D1PreparedStatement[]) => execute(async () =>
      (await database.batch<T>(batch.map(statement => statements.get(statement) ?? statement))).map(record)),
    // exec() has no billing metadata. Keep its semantics and mark coverage incomplete.
    exec: sql => { usage.complete = false; return database.exec(sql); },
  };
  return { db, usage, add };
}

/** Each invocation owns its meter; child request totals are included once. Alarms are separate. */
export async function withD1Usage(env: Env, action: (env: Env) => Promise<Response>): Promise<Response> {
  const meter = meterD1Usage(env.DB);
  const namespace = env.REMINDER_ALARMS;
  const measuredEnv = { ...env, DB: meter.db, ...(namespace ? { REMINDER_ALARMS: {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          const response = await stub.fetch(input, init);
          meter.add(parseD1Usage(response.headers.get(D1_USAGE_HEADER)));
          return response;
        } catch (error) { meter.add(); throw error; }
      } };
    },
  } } : {}) };
  const response = await action(measuredEnv);
  const headers = new Headers(response.headers);
  const { rowsRead, rowsWritten, complete } = meter.usage;
  headers.set(D1_USAGE_HEADER, `${rowsRead}:${rowsWritten}:${complete ? 1 : 0}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
