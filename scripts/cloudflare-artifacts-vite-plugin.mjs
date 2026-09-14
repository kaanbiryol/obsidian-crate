import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIRTUAL_ID = 'virtual:crate-cloudflare-artifacts';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

function sha256(content) {
	return createHash('sha256').update(content).digest('hex');
}

export function cloudflareArtifactsPlugin({ rootDir }) {
	return {
		name: 'crate-cloudflare-artifacts',
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
		},
		load(id) {
			if (id !== RESOLVED_VIRTUAL_ID) return null;

			const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
			const workerBundle = readFileSync(resolve(rootDir, '.generated/cloudflare/worker.mjs'));
			const workerBundleSha256 = sha256(workerBundle);
			const d1Schema = readFileSync(resolve(rootDir, 'src/cloudflare/schema.sql'), 'utf8');
			const d1SchemaSha256 = sha256(d1Schema);
			const serverRelease = JSON.parse(readFileSync(resolve(rootDir, 'src/cloudflare/server-release.json'), 'utf8'));
      if (!Number.isSafeInteger(serverRelease.revision) || serverRelease.revision < 1
        || !Number.isSafeInteger(serverRelease.schemaVersion) || serverRelease.schemaVersion < 1
        || !Number.isSafeInteger(serverRelease.minimumSchemaVersion) || serverRelease.minimumSchemaVersion < 1
        || serverRelease.minimumSchemaVersion > serverRelease.schemaVersion || !Array.isArray(serverRelease.migrations)) throw new Error('Invalid server release manifest');
      let schemaVersion = 1;
      const migrationIds = new Set();
      for (const migration of serverRelease.migrations) {
        if (!/^[a-z0-9-]+$/.test(migration.id) || migrationIds.has(migration.id) || migration.from !== schemaVersion || migration.to !== schemaVersion + 1
          || migration.file !== `${migration.id}.sql`) throw new Error('Invalid database migration chain');
        migrationIds.add(migration.id);
        schemaVersion = migration.to;
        if (!/^[a-z0-9-]+\.sql$/.test(migration.file) || sha256(readFileSync(resolve(rootDir, 'src/cloudflare/migrations', migration.file))) !== migration.checksum) throw new Error('Invalid database migration artifact');
      }
      if (schemaVersion !== serverRelease.schemaVersion) throw new Error('Missing database migration path');
      const artifactFingerprint = sha256(JSON.stringify({ workerBundleSha256, d1SchemaSha256, serverRelease }));

			return [
				`export const artifactVersion = ${JSON.stringify(packageJson.version)};`,
				`export const workerBundleGzipBase64 = ${JSON.stringify(gzipSync(workerBundle).toString('base64'))};`,
				`export const workerBundleSha256 = ${JSON.stringify(workerBundleSha256)};`,
				`export const artifactFingerprint = ${JSON.stringify(artifactFingerprint)};`,
				`export const d1SchemaGzipBase64 = ${JSON.stringify(gzipSync(d1Schema).toString('base64'))};`,
				`export const d1SchemaSha256 = ${JSON.stringify(d1SchemaSha256)};`,
			].join('\n');
		},
	};
}
