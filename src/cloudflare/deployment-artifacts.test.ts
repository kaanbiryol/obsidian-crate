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
		})).rejects.toThrow('integrity check');
	});


});
