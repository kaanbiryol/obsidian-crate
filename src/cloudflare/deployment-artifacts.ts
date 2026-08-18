export interface D1MigrationArtifact {
	name: string;
	sql: string;
	sha256: string;
}

export interface CloudflareDeploymentArtifacts {
	version: string;
	workerBundle: string;
	workerBundleSha256: string;
	d1Migrations: D1MigrationArtifact[];
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const decoded = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		decoded[index] = binary.charCodeAt(index);
	}
	return decoded;
}

export async function sha256Hex(content: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	return [...new Uint8Array(digest)]
		.map(byte => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function decodeAndVerifyArtifacts(input: {
	version: string;
	workerBundleGzipBase64: string;
	workerBundleSha256: string;
	d1Migrations: D1MigrationArtifact[];
}): Promise<CloudflareDeploymentArtifacts> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This Obsidian version cannot unpack the embedded Cloudflare deployment');
	}

	const compressed = decodeBase64(input.workerBundleGzipBase64);
	const stream = new Blob([compressed])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'));
	const workerBundle = await new Response(stream).text();
	if (await sha256Hex(workerBundle) !== input.workerBundleSha256) {
		throw new Error('The embedded Cloudflare Worker failed its integrity check');
	}

	for (const migration of input.d1Migrations) {
		if (await sha256Hex(migration.sql) !== migration.sha256) {
			throw new Error(`Embedded D1 migration ${migration.name} failed its integrity check`);
		}
	}

	return {
		version: input.version,
		workerBundle,
		workerBundleSha256: input.workerBundleSha256,
		d1Migrations: input.d1Migrations,
	};
}
