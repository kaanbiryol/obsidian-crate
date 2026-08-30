export interface D1MigrationArtifact {
	name: string;
	sql: string;
	sha256: string;
}

export interface CloudflareDeploymentArtifacts {
	version: string;
	fingerprint: string;
	workerBundle: string;
	workerBundleSha256: string;
	d1Schema: string;
	d1SchemaSha256: string;
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
	fingerprint: string;
	workerBundleGzipBase64: string;
	workerBundleSha256: string;
	d1Schema: string;
	d1SchemaSha256: string;
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

	if (await sha256Hex(input.d1Schema) !== input.d1SchemaSha256) {
		throw new Error('The embedded D1 schema failed its integrity check');
	}

	const migrationNames = new Set<string>();
	let previousMigrationName = '';
	for (const migration of input.d1Migrations) {
		if (
			!/^\d{4}_[a-z0-9_-]+\.sql$/.test(migration.name)
			|| migrationNames.has(migration.name)
			|| migration.name.localeCompare(previousMigrationName) <= 0
		) {
			throw new Error('The embedded D1 migration list is invalid');
		}
		migrationNames.add(migration.name);
		previousMigrationName = migration.name;
		if (await sha256Hex(migration.sql) !== migration.sha256) {
			throw new Error(`The embedded D1 migration ${migration.name} failed its integrity check`);
		}
	}

	return {
		version: input.version,
		fingerprint: input.fingerprint,
		workerBundle,
		workerBundleSha256: input.workerBundleSha256,
		d1Schema: input.d1Schema,
		d1SchemaSha256: input.d1SchemaSha256,
		d1Migrations: input.d1Migrations,
	};
}
