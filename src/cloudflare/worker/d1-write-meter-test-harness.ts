/** Count the D1 billing metadata without replacing database execution. */
export function meterD1Writes(database: D1Database): { db: D1Database; writes: () => number } {
  let writes = 0;
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function record<T>(result: T): T {
    const rowsWritten = (result as { meta: { rows_written: number } }).meta.rows_written;
    if (!Number.isFinite(rowsWritten)) throw new Error('D1 did not return write billing metadata');
    writes += rowsWritten;
    return result;
  }
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      run: async () => record(await statement.run()),
      all: async <T = Record<string, unknown>>() => record(await statement.all<T>()),
      first: statement.first.bind(statement),
    };
    statements.set(wrapped, statement);
    return wrapped;
  }
  const db: D1Database = {
    prepare: sql => wrap(database.prepare(sql)),
    batch: async <T>(batch: D1PreparedStatement[]) =>
      (await database.batch<T>(batch.map(statement => statements.get(statement) ?? statement))).map(record),
    exec: database.exec.bind(database),
  };
  return { db, writes: () => writes };
}
