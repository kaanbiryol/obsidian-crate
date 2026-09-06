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
			const artifactFingerprint = sha256(JSON.stringify({ workerBundleSha256, d1SchemaSha256 }));

			return [
				`export const artifactVersion = ${JSON.stringify(packageJson.version)};`,
				`export const workerBundleGzipBase64 = ${JSON.stringify(gzipSync(workerBundle).toString('base64'))};`,
				`export const workerBundleSha256 = ${JSON.stringify(workerBundleSha256)};`,
				`export const artifactFingerprint = ${JSON.stringify(artifactFingerprint)};`,
				`export const d1Schema = ${JSON.stringify(d1Schema)};`,
				`export const d1SchemaSha256 = ${JSON.stringify(d1SchemaSha256)};`,
			].join('\n');
		},
	};
}
