import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serverAssetPath, upgradeRulesPath } from './assets.mjs';

// The Cloudflare provisioner's manifest, history and transaction rules.
const { migrationTransactionSql, planDatabaseUpgrade, validateMigrationHistory } = await import(pathToFileURL(upgradeRulesPath).href);
const readMigration = file => readFile(serverAssetPath(`migrations/${file}`), 'utf8');

// server.json records the schema version beside its hash, like crate_release on
// Cloudflare. A changed schema needs an older version with a registered path.
export function assertLocalMigrationPath(schemaVersion, release) {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion >= release.schemaVersion) throw new Error('No tested migration exists for this data directory.');
  planDatabaseUpgrade(schemaVersion, release);
}

export async function migrateLocalDatabase(db, release, readSql = readMigration) {
  const verify = async () => {
    const marker = await db.prepare('SELECT version, created_version FROM crate_schema WHERE id=1').first();
    if (!Number.isSafeInteger(marker?.version)) throw new Error('Unsupported local schema. Restore using the matching server build.');
    validateMigrationHistory(marker.version, marker.created_version, (await db.prepare('SELECT id, checksum FROM crate_migrations').all()).results, release);
    return marker.version;
  };
  const counts = () => db.prepare('SELECT (SELECT count(*) FROM auth_tokens) AS tokens, (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM file_versions) AS versions').first();
  const version = await verify();
  const before = await counts();
  for (const migration of planDatabaseUpgrade(version, release)) {
    const sql = await readSql(migration.file);
    if (createHash('sha256').update(sql).digest('hex') !== migration.checksum) throw new Error('Database migration failed its integrity check');
    // One prepared query runs the whole script in one D1 transaction, like the
    // Cloudflare query API, so triggers and quoted semicolons stay intact.
    await db.prepare(migrationTransactionSql(migration, sql)).run();
  }
  await verify();
  if (JSON.stringify(before) !== JSON.stringify(await counts())) throw new Error('Upgrade verification failed. Keep the stopped server and its backup.');
}
