import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function migrateLocalDatabase(db, root, packaged, release) {
  const marker = await db.prepare('SELECT version, created_version FROM crate_schema WHERE id=1').first();
  if (!marker || !Number.isSafeInteger(marker.version) || marker.version < release.minimumSchemaVersion || marker.version > release.schemaVersion) throw new Error('Unsupported local schema. Restore using the matching server build.');
  const verify = async () => {
    const current = await db.prepare('SELECT version, created_version FROM crate_schema WHERE id=1').first();
    const receipts = (await db.prepare('SELECT id, checksum FROM crate_migrations').all()).results;
    const expected = release.migrations.filter(step => step.from >= current.created_version && step.to <= current.version);
    if (receipts.length !== expected.length || expected.some(step => !receipts.some(row => row.id === step.id && row.checksum === step.checksum))) throw new Error('Local migration history does not match this build.');
  };
  await verify();
  const before = await db.prepare('SELECT (SELECT count(*) FROM auth_tokens) AS tokens, (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM file_versions) AS versions').first();
  for (const step of release.migrations.filter(step => step.from >= marker.version)) {
    if (step.to !== step.from + 1 || step.file !== `${step.id}.sql` || !/^[a-z0-9-]+$/.test(step.id)) throw new Error('Invalid local migration manifest');
    const sql = await readFile(join(root, packaged ? 'assets/migrations' : 'src/cloudflare/migrations', step.file), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== step.checksum) throw new Error('Local migration checksum failed');
    await db.batch([
      db.prepare('INSERT INTO crate_schema(id,version,created_version) SELECT 2,0,1 WHERE NOT EXISTS (SELECT 1 FROM crate_schema WHERE id=1 AND version=?)').bind(step.from),
      ...sql.split(';').map(value => value.trim()).filter(Boolean).map(value => db.prepare(value)),
      db.prepare('INSERT INTO crate_migrations(id,checksum) VALUES (?,?)').bind(step.id, step.checksum),
      db.prepare('UPDATE crate_schema SET version=? WHERE id=1').bind(step.to),
    ]);
  }
  await verify();
  const after = await db.prepare('SELECT (SELECT count(*) FROM auth_tokens) AS tokens, (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM file_versions) AS versions').first();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Upgrade verification failed. Keep the stopped server and its backup.');
}
