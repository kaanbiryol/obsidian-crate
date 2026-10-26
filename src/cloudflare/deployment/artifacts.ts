import type { DevelopmentBuild } from '../../protocol/server-build';
import { sha256Hex } from '../../platform/sha256';
import { base64ToArrayBuffer } from '../../sync/encoding';

export interface CloudflareDeploymentArtifacts {
	development?: DevelopmentBuild;
	version: string;
	fingerprint: string;
	workerBundle: string;
	workerBundleSha256: string;
	d1Schema: string;
	d1SchemaSha256: string;
}

export async function decodeAndVerifyArtifacts(input: {
	development?: DevelopmentBuild;
	version: string;
	fingerprint: string;
	workerBundleGzipBase64: string;
	workerBundleSha256: string;
	d1SchemaGzipBase64: string;
	d1SchemaSha256: string;
}): Promise<CloudflareDeploymentArtifacts> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This Obsidian version cannot unpack the embedded Cloudflare deployment');
	}

	const workerBundle = await decompressArtifact(input.workerBundleGzipBase64);
	if (await sha256Hex(workerBundle) !== input.workerBundleSha256) {
		throw new Error('The embedded Cloudflare Worker failed its integrity check');
	}

	const d1Schema = await decompressArtifact(input.d1SchemaGzipBase64);
	if (await sha256Hex(d1Schema) !== input.d1SchemaSha256) {
		throw new Error('The embedded D1 schema failed its integrity check');
	}

	return {
		development: input.development,
		version: input.version,
		fingerprint: input.fingerprint,
		workerBundle,
		workerBundleSha256: input.workerBundleSha256,
		d1Schema,
		d1SchemaSha256: input.d1SchemaSha256,
	};
}

async function decompressArtifact(gzipBase64: string): Promise<string> {
	const compressed = base64ToArrayBuffer(gzipBase64);
	const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).text();
}
