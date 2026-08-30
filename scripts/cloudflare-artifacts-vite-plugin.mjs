import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
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
			const migrationsDir = resolve(rootDir, 'src/cloudflare/migrations');
			const d1Migrations = readdirSync(migrationsDir, { withFileTypes: true })
				.filter(entry => entry.isFile() && /^\d{4}_[a-z0-9_-]+\.sql$/.test(entry.name))
				.map(entry => {
					const sql = readFileSync(resolve(migrationsDir, entry.name), 'utf8');
					return { name: entry.name, sql, sha256: sha256(sql) };
				})
				.sort((left, right) => left.name.localeCompare(right.name));
			const artifactFingerprint = sha256(JSON.stringify({
				workerBundleSha256,
				d1SchemaSha256,
				d1Migrations: d1Migrations.map(({ name, sha256: migrationSha256 }) => ({
					name,
					sha256: migrationSha256,
				})),
			}));

			return [
				`export const artifactVersion = ${JSON.stringify(packageJson.version)};`,
				`export const workerBundleGzipBase64 = ${JSON.stringify(gzipSync(workerBundle).toString('base64'))};`,
				`export const workerBundleSha256 = ${JSON.stringify(workerBundleSha256)};`,
				`export const artifactFingerprint = ${JSON.stringify(artifactFingerprint)};`,
				`export const d1Schema = ${JSON.stringify(d1Schema)};`,
				`export const d1SchemaSha256 = ${JSON.stringify(d1SchemaSha256)};`,
				`export const d1Migrations = ${JSON.stringify(d1Migrations)};`,
			].join('\n');
		},
	};
}
