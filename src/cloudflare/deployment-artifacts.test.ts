import { describe, expect, it } from 'vitest';
import { decodeAndVerifyArtifacts, sha256Hex } from './deployment-artifacts';

async function gzipBase64(content: string): Promise<string> {
	const input = new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'));
	const compressed = new Uint8Array(await new Response(input).arrayBuffer());
	return btoa(String.fromCharCode(...compressed));
}

describe('embedded Cloudflare deployment artifacts', () => {
	it('decompresses and verifies the build-time Worker and initial schema', async () => {
		const workerBundle = 'export default { fetch() { return new Response("ok"); } };';
		const schemaSql = 'CREATE TABLE IF NOT EXISTS example (id TEXT PRIMARY KEY);';
		const artifacts = await decodeAndVerifyArtifacts({
			version: '0.1.0',
			fingerprint: 'f'.repeat(64),
			workerBundleGzipBase64: await gzipBase64(workerBundle),
			workerBundleSha256: await sha256Hex(workerBundle),
			d1Schema: schemaSql,
			d1SchemaSha256: await sha256Hex(schemaSql),
			d1Migrations: [],
		});

		expect(artifacts.workerBundle).toBe(workerBundle);
		expect(artifacts.fingerprint).toBe('f'.repeat(64));
		expect(artifacts.d1Schema).toBe(schemaSql);
	});

	it('rejects an artifact whose declared hash does not match', async () => {
		await expect(decodeAndVerifyArtifacts({
			version: '0.1.0',
			fingerprint: 'f'.repeat(64),
			workerBundleGzipBase64: await gzipBase64('worker-code'),
			workerBundleSha256: '0'.repeat(64),
			d1Schema: '',
			d1SchemaSha256: await sha256Hex(''),
			d1Migrations: [],
		})).rejects.toThrow('integrity check');
	});

	it('verifies embedded migration names and hashes', async () => {
		const migrationSql = 'ALTER TABLE example ADD COLUMN title TEXT;';
		const artifacts = await decodeAndVerifyArtifacts({
			version: '0.2.0',
			fingerprint: 'f'.repeat(64),
			workerBundleGzipBase64: await gzipBase64('worker-code'),
			workerBundleSha256: await sha256Hex('worker-code'),
			d1Schema: '',
			d1SchemaSha256: await sha256Hex(''),
			d1Migrations: [{
				name: '0002_add_title.sql',
				sql: migrationSql,
				sha256: await sha256Hex(migrationSql),
			}],
		});

		expect(artifacts.d1Migrations).toHaveLength(1);
		await expect(decodeAndVerifyArtifacts({
			version: '0.2.0',
			fingerprint: 'f'.repeat(64),
			workerBundleGzipBase64: await gzipBase64('worker-code'),
			workerBundleSha256: await sha256Hex('worker-code'),
			d1Schema: '',
			d1SchemaSha256: await sha256Hex(''),
			d1Migrations: [{ name: '../unsafe.sql', sql: migrationSql, sha256: await sha256Hex(migrationSql) }],
		})).rejects.toThrow('migration list is invalid');

		await expect(decodeAndVerifyArtifacts({
			version: '0.2.0',
			fingerprint: 'f'.repeat(64),
			workerBundleGzipBase64: await gzipBase64('worker-code'),
			workerBundleSha256: await sha256Hex('worker-code'),
			d1Schema: '',
			d1SchemaSha256: await sha256Hex(''),
			d1Migrations: [
				{ name: '0003_later.sql', sql: migrationSql, sha256: await sha256Hex(migrationSql) },
				{ name: '0002_earlier.sql', sql: migrationSql, sha256: await sha256Hex(migrationSql) },
			],
		})).rejects.toThrow('migration list is invalid');
	});
});
