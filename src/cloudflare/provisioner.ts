import type { CloudflareDeploymentMetadata } from '../plugin/types';
import { CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import { randomHex } from './pkce';
import { CLOUDFLARE_MAINTENANCE_CRON } from './maintenance-schedule';

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
	await input.api.queryD1(
		input.accountId,
		input.databaseId,
		input.artifacts.d1Schema,
	);
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
}): Promise<string> {
	const databaseId = await ensureD1Database(input.api, input.accountId, input.metadata);
	if (input.metadata.d1DatabaseId !== databaseId) {
		input.metadata.d1DatabaseId = databaseId;
		await input.onMetadataChanged();
	}

	await ensureR2Bucket(input.api, input.accountId, input.metadata.r2BucketName);
	await initializeD1Schema({
		api: input.api,
		accountId: input.accountId,
		databaseId,
		artifacts: input.artifacts,
	});
	await input.api.uploadWorker({
		accountId: input.accountId,
		workerName: input.metadata.workerName,
		artifacts: input.artifacts,
		d1DatabaseId: databaseId,
		r2BucketName: input.metadata.r2BucketName,
	});
	await input.api.updateWorkerSchedules(
		input.accountId,
		input.metadata.workerName,
		[CLOUDFLARE_MAINTENANCE_CRON],
	);

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
