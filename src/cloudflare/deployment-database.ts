import { canReplaceServerBuild, parseDevelopmentBuild } from './server-build';
import { upgradeGuards, removeUpgradeGuards } from './upgrade-checkpoint';
import type { CloudflareApiClient } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import { DEPLOYMENT_FENCE_KEY, type DeploymentFence } from './deployment-fence';
import { migrationTransaction, planDatabaseUpgrade, validateMigrationHistory, SERVER_RELEASE, type DatabaseMigration } from './database-upgrades';

export interface DeploymentDatabase {
  api: Pick<CloudflareApiClient, 'queryD1'>;
  accountId: string;
  databaseId: string;
  artifacts: CloudflareDeploymentArtifacts;
}

export async function inspectDeploymentDatabase(input: DeploymentDatabase): Promise<number | null> {
  const query = async (sql: string) => (await input.api.queryD1(input.accountId, input.databaseId, sql)).flatMap(result => result.results ?? []);
  const tables = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';")).map(row => row.name);
  if (!tables.length) return null;
  if (tables.length === 1 && tables[0] === 'maintenance_state'
    && !(await query(`SELECT key FROM maintenance_state WHERE key != '${DEPLOYMENT_FENCE_KEY}' LIMIT 1;`)).length) return null;
  if (!tables.includes('crate_schema')) throw new Error('Unsupported database schema. Use an empty database or a current Crate deployment.');
  const versions = await query('SELECT version, created_version FROM crate_schema WHERE id = 1;');
  if (versions.length !== 1 || typeof versions[0]?.version !== 'number') throw new Error('Unsupported database schema. Use a matching Crate build.');
  const version = versions[0].version;
  const createdVersion = versions[0].created_version;
  if (!Number.isSafeInteger(createdVersion) || Number(createdVersion) < 1 || Number(createdVersion) > version) throw new Error('Unsupported database schema baseline');
  planDatabaseUpgrade(version);
  const releases = await query('SELECT revision, fingerprint, schema_version, schema_hash FROM crate_release WHERE id = 1;');
  const deployed = releases[0];
  if (releases.length > 1 || deployed && (!Number.isSafeInteger(deployed.revision) || Number(deployed.revision) < 1
    || !Number.isSafeInteger(deployed.schema_version) || Number(deployed.schema_version) < 1
    || typeof deployed.fingerprint !== 'string' || typeof deployed.schema_hash !== 'string')) throw new Error('Invalid saved server release');
  const development = deployed ? await readDeploymentBuild(input, String(deployed.fingerprint)) : undefined;
  if (deployed && !canReplaceServerBuild({ revision: Number(deployed.revision), fingerprint: String(deployed.fingerprint), development },
    { revision: SERVER_RELEASE.revision, fingerprint: input.artifacts.fingerprint, development: input.artifacts.development })) {
    throw new Error('This server uses a newer or different build of this server revision. Install its matching plugin or a newer server revision; server downgrades are not supported.');
  }
  if (deployed && deployed.schema_version === SERVER_RELEASE.schemaVersion && deployed.schema_hash !== input.artifacts.d1SchemaSha256) {
    throw new Error('The database definition changed without a schema version change. An explicit migration is required.');
  }
  const receipts = await query('SELECT id, checksum FROM crate_migrations;');
  validateMigrationHistory(version, createdVersion, receipts);
  return version;
}

export async function prepareDeploymentDatabase(input: DeploymentDatabase, version: number | null, fence: DeploymentFence,
  beforeUpgrade?: (migrations: readonly DatabaseMigration[]) => Promise<void>): Promise<void> {
  const migrations = planDatabaseUpgrade(version);
  // Every future data migration must integrate a verified paired D1/R2 backup.
  // Ordinary code updates and first installation do not need that operation.
  if (migrations.length) {
    if (!beforeUpgrade) throw new Error('This database upgrade requires a verified recovery checkpoint. Use a build that supports its upgrade workflow.');
    await beforeUpgrade(migrations);
    fence.requireVerification();
    for (const migration of migrations) {
      const sql = `${removeUpgradeGuards('auth_tokens')}\n${await migrationTransaction(migration)}\n${upgradeGuards('auth_tokens')}`;
      await fence.mutate(() => input.api.queryD1(input.accountId, input.databaseId, sql), `migrate-${migration.id}`);
    }
  } else if (version === null) {
    fence.requireVerification();
    await fence.mutate(() => input.api.queryD1(input.accountId, input.databaseId, input.artifacts.d1Schema), 'initialize-database');
  }
}

export async function recordDeploymentRelease(input: DeploymentDatabase, fence: DeploymentFence, revision = SERVER_RELEASE.revision): Promise<void> {
  const quote = (value: string | number) => `'${String(value).replaceAll("'", "''")}'`;
  const values = [revision, input.artifacts.fingerprint, SERVER_RELEASE.schemaVersion, input.artifacts.d1SchemaSha256].map(quote).join(', ');
  const identity = quote(JSON.stringify({ fingerprint: input.artifacts.fingerprint, development: input.artifacts.development ?? null }));
  // One D1 transaction records both the release and its fingerprint-bound development identity.
  await fence.mutate(() => input.api.queryD1(input.accountId, input.databaseId,
    `INSERT INTO crate_release(id, revision, fingerprint, schema_version, schema_hash) VALUES (1, ${values}) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, fingerprint = excluded.fingerprint, schema_version = excluded.schema_version, schema_hash = excluded.schema_hash;
INSERT INTO maintenance_state(key, value) VALUES ('crate_development_build', ${identity}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`), 'record-release');
}

/** The sidecar is bound to the verified release fingerprint, never inferred from local settings. */
export async function readDeploymentBuild(input: DeploymentDatabase, fingerprint: string) {
  const rows = (await input.api.queryD1(input.accountId, input.databaseId,
    "SELECT value FROM maintenance_state WHERE key = 'crate_development_build';")).flatMap(row => row.results ?? []);
  if (!rows.length) return undefined;
  if (rows.length !== 1 || typeof rows[0]?.value !== 'string') throw new Error('Invalid saved development build');
  const value = JSON.parse(rows[0].value) as Record<string, unknown>;
  if (value.fingerprint !== fingerprint) throw new Error('Development build does not match the saved release');
  if (value.development === null) return undefined;
  const development = parseDevelopmentBuild(value.development);
  if (!development) throw new Error('Invalid saved development build');
  return development;
}
