import type { CloudflareDeploymentMetadata } from './deployment-types';
import { CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import { randomHex } from './pkce';
import { CLOUDFLARE_MAINTENANCE_CRON } from './maintenance-schedule';
import { deployedArtifact } from './deployment-discovery';
import { assertDeploymentIsNotDowngrade } from './deployment-update';

async function ensureD1Database(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
): Promise<string> {
	if (metadata.d1DatabaseId) {
		const existingById = await api.getD1Database(accountId, metadata.d1DatabaseId);
		if (existingById?.uuid) return existingById.uuid;
	}

	const existingByName = await api.findD1Database(accountId, metadata.d1DatabaseName);
	if (existingByName?.uuid) return existingByName.uuid;
	const created = await api.createD1Database(accountId, metadata.d1DatabaseName);
	if (!created.uuid) throw new Error('Cloudflare did not return the new D1 database ID');
	return created.uuid;
}

async function ensureR2Bucket(
	api: CloudflareApiClient,
	accountId: string,
	bucketName: string,
): Promise<void> {
	try {
		if (await api.getR2Bucket(accountId, bucketName)) return;
		await api.createR2Bucket(accountId, bucketName);
	} catch (error) {
		if (error instanceof CloudflareApiError && error.code === 10042) {
			throw new Error(
				'R2 is not active for this Cloudflare account. Enable an R2 subscription in the Cloudflare dashboard, then select Connect with Cloudflare again.',
			);
		}
		throw error;
	}
}

async function initializeD1Schema(input: {
	api: CloudflareApiClient;
	accountId: string;
	databaseId: string;
	artifacts: CloudflareDeploymentArtifacts;
}): Promise<void> {
	const query = (sql: string) => input.api.queryD1(input.accountId, input.databaseId, sql);
	const tables = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';"))
		.flatMap(result => result.results ?? []).map(row => row.name);
	if (tables.length > 0) {
		if (!tables.includes('crate_schema')) throw new Error('Unsupported database schema. Use an empty database or a current Crate deployment.');
		const versions = (await query('SELECT version FROM crate_schema WHERE id = 1;')).flatMap(result => result.results ?? []);
		if (versions.length !== 1 || versions[0]?.version !== 2) throw new Error('Unsupported database schema. Use a matching Crate build.');
	}
	// The current schema is idempotent so an interrupted initialization can retry.
	await query(input.artifacts.d1Schema);
}

async function ensureWorkersSubdomain(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
): Promise<string> {
	const existing = await api.getWorkersSubdomain(accountId);
	if (existing) return existing;

	const candidates = [
		metadata.workersSubdomain,
		`crate-${metadata.deploymentId}`,
		`crate-${metadata.deploymentId}-${randomHex(2)}`,
	].filter((value): value is string => Boolean(value));
	let lastError: unknown = null;
	for (const candidate of candidates) {
		try {
			return await api.createWorkersSubdomain(accountId, candidate);
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error('Cloudflare could not create a workers.dev subdomain');
}

export async function provisionCloudflareDeployment(input: {
	api: CloudflareApiClient;
	accountId: string;
	metadata: CloudflareDeploymentMetadata;
	artifacts: CloudflareDeploymentArtifacts;
	onMetadataChanged: () => Promise<void>;
	onProgress?: (message: string) => void;
}): Promise<string> {
	// Read remote identity, never rely on another device's saved metadata.
	try {
		const settings = await input.api.getWorkerSettings(input.accountId, input.metadata.workerName);
		const remote = deployedArtifact(settings);
		const ownResetStub = input.metadata.reset && settings.annotations?.['workers/message'] === `Crate reset ${input.metadata.reset.id}`;
		if (!ownResetStub) assertDeploymentIsNotDowngrade(remote.version, input.artifacts.version);
	} catch (error) {
		if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
	}
	input.onProgress?.('Preparing the server database…');
	const databaseId = await ensureD1Database(input.api, input.accountId, input.metadata);
	if (!databaseId) throw new Error('Cloudflare did not return the new D1 database ID');
	if (input.metadata.d1DatabaseId !== databaseId) {
		input.metadata.d1DatabaseId = databaseId;
		await input.onMetadataChanged();
	}

	input.onProgress?.('Preparing the remote file bucket…');
	await ensureR2Bucket(input.api, input.accountId, input.metadata.r2BucketName);
	input.onProgress?.('Initializing the database schema…');
	await initializeD1Schema({
		api: input.api,
		accountId: input.accountId,
		databaseId,
		artifacts: input.artifacts,
	});
	input.onProgress?.('Uploading the Worker and web app to Cloudflare…');
	await input.api.uploadWorker({
		accountId: input.accountId,
		workerName: input.metadata.workerName,
		artifacts: input.artifacts,
		d1DatabaseId: databaseId,
		r2BucketName: input.metadata.r2BucketName,
	});
	input.onProgress?.('Configuring server maintenance…');
	await input.api.updateWorkerSchedules(
		input.accountId,
		input.metadata.workerName,
		[CLOUDFLARE_MAINTENANCE_CRON],
	);

	input.onProgress?.('Enabling the server address…');
	const workersSubdomain = await ensureWorkersSubdomain(input.api, input.accountId, input.metadata);
	if (input.metadata.workersSubdomain !== workersSubdomain) {
		input.metadata.workersSubdomain = workersSubdomain;
		await input.onMetadataChanged();
	}
	await input.api.enableWorkerSubdomain(input.accountId, input.metadata.workerName);

	if (
		input.metadata.lastDeployedVersion !== input.artifacts.version
		|| input.metadata.lastDeployedFingerprint !== input.artifacts.fingerprint
	) {
		input.metadata.lastDeployedVersion = input.artifacts.version;
		input.metadata.lastDeployedFingerprint = input.artifacts.fingerprint;
		await input.onMetadataChanged();
	}
	return `https://${input.metadata.workerName}.${workersSubdomain}.workers.dev`;
}
