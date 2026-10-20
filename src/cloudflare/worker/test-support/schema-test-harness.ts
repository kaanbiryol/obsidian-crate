import schema from '../../schema.sql?raw';

/** Creates the current schema, in one transaction like a fresh deployment. */
export async function applySchema(db: D1Database): Promise<void> {
  await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
}
