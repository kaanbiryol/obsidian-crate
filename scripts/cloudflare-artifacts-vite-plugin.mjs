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
			const migrationsDir = resolve(rootDir, 'migrations');
			const migrations = readdirSync(migrationsDir)
				.filter(name => name.endsWith('.sql'))
				.sort()
				.map(name => {
					const sql = readFileSync(resolve(migrationsDir, name), 'utf8');
					return { name, sql, sha256: sha256(sql) };
				});

			return [
				`export const artifactVersion = ${JSON.stringify(packageJson.version)};`,
				`export const workerBundleGzipBase64 = ${JSON.stringify(gzipSync(workerBundle).toString('base64'))};`,
				`export const workerBundleSha256 = ${JSON.stringify(sha256(workerBundle))};`,
				`export const d1Migrations = ${JSON.stringify(migrations)};`,
			].join('\n');
		},
	};
}
