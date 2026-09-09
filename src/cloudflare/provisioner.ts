import type { CloudflareDeploymentMetadata } from './deployment-types';
import { CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import { randomHex } from './pkce';
import { CLOUDFLARE_MAINTENANCE_CRON } from './maintenance-schedule';
import { deployedArtifact } from './deployment-discovery';
import { assertDeploymentIsNotDowngrade } from './deployment-update';
import { DEPLOYMENT_FENCE_KEY, withDeploymentFence, type DeploymentFence } from './deployment-fence';

async function ensureD1Database(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
): Promise<string> {
	if (metadata.d1DatabaseId) {
		const existingById = await api.getD1Database(accountId, metadata.d1DatabaseId);
		if (existingById?.uuid) {
			const named = await api.findD1Database(accountId, metadata.d1DatabaseName);
			if (existingById.name !== metadata.d1DatabaseName || named?.uuid !== existingById.uuid) throw new Error('The deployment database identity is ambiguous or changed. Reconnect to the intended server.');
			return existingById.uuid;
		}
	}

	const existingByName = await api.findD1Database(accountId, metadata.d1DatabaseName);
	if (existingByName?.uuid) return existingByName.uuid;
	let created;
	try { created = await api.createD1Database(accountId, metadata.d1DatabaseName); }
	catch (error) {
		// Cloudflare's D1 create endpoint rejects an existing account/name with
		// 7502 (also handled by Wrangler). Never infer a completed creation from
		// a transport failure or an unrelated API error.
		if (!(error instanceof CloudflareApiError && error.code === 7502 && error.status >= 400 && error.status < 500)) throw error;
		const existing = await api.findD1Database(accountId, metadata.d1DatabaseName);
		if (!existing?.uuid) throw error;
		return existing.uuid;
	}
	if (!created.uuid) throw new Error('Cloudflare did not return the new D1 database ID');
	const named = await api.findD1Database(accountId, metadata.d1DatabaseName);
	if (named?.uuid !== created.uuid) throw new Error('The deployment database identity changed during creation. Inspect the deployment resources before retrying.');
	return created.uuid;
}

async function ensureR2Bucket(
	api: CloudflareApiClient,
	accountId: string,
	bucketName: string,
	fence: DeploymentFence,
): Promise<void> {
	try {
		if (await api.getR2Bucket(accountId, bucketName)) return;
		await fence.mutate(() => api.createR2Bucket(accountId, bucketName));
	} catch (error) {
		if (error instanceof CloudflareApiError && error.code === 10042) {
			throw new Error(
				'R2 is not active for this Cloudflare account. Enable an R2 subscription in the Cloudflare dashboard, then select Connect with Cloudflare again.',
			);
		}
		throw error;
	}
}

async function validateD1Schema(input: {
	api: CloudflareApiClient;
	accountId: string;
	databaseId: string;
	artifacts: CloudflareDeploymentArtifacts;
}): Promise<void> {
	const query = (sql: string) => input.api.queryD1(input.accountId, input.databaseId, sql);
	const tables = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';"))
		.flatMap(result => result.results ?? []).map(row => row.name);
	if (tables.length === 1 && tables[0] === 'maintenance_state') {
		const unexpected = (await query(`SELECT key FROM maintenance_state WHERE key != '${DEPLOYMENT_FENCE_KEY}' LIMIT 1;`)).flatMap(result => result.results ?? []);
		if (unexpected.length === 0) return; // Interrupted empty-database fence bootstrap.
	}
	if (tables.length > 0) {
		if (!tables.includes('crate_schema')) throw new Error('Unsupported database schema. Use an empty database or a current Crate deployment.');
		const versions = (await query('SELECT version FROM crate_schema WHERE id = 1;')).flatMap(result => result.results ?? []);
		if (versions.length !== 1 || versions[0]?.version !== 2 && versions[0]?.version !== 3 && versions[0]?.version !== 4 && versions[0]?.version !== 5) throw new Error('Unsupported database schema. Use a matching Crate build.');
	}
}

async function checkRemoteDeployment(input: { api: CloudflareApiClient; accountId: string; metadata: CloudflareDeploymentMetadata; artifacts: CloudflareDeploymentArtifacts }): Promise<string | null> {
	try {
		const settings = await input.api.getWorkerSettings(input.accountId, input.metadata.workerName);
		const message = settings.annotations?.['workers/message'];
		const ownResetStub = input.metadata.reset?.phase === 'rebuilding' && message === `Crate reset ${input.metadata.reset.id}`;
		if (message?.startsWith('Crate reset ') && !ownResetStub) throw new Error('This server is being reset or deleted. Finish that operation before updating.');
		if (!ownResetStub) assertDeploymentIsNotDowngrade(deployedArtifact(settings).version, input.artifacts.version);
		const database = settings.bindings?.filter(binding => binding.type === 'd1');
		const bucket = settings.bindings?.filter(binding => binding.type === 'r2_bucket');
		const expectedDatabase = ownResetStub ? input.metadata.reset!.databaseId : input.metadata.d1DatabaseId;
		if (!message?.startsWith('Crate ') || database?.length !== 1 || database[0]?.name !== 'DB'
			|| !database[0]?.id || expectedDatabase && database[0].id !== expectedDatabase
			|| bucket?.length !== 1 || bucket[0]?.name !== 'BUCKET' || bucket[0]?.bucket_name !== input.metadata.r2BucketName) {
			throw new Error('The live Worker bindings do not match this deployment. Reconnect to the correct server before updating.');
		}
		return JSON.stringify([message, database[0].id, bucket[0].bucket_name]);
	} catch (error) {
		if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
		return null;
	}
}

async function ensureWorkersSubdomain(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
	fence: DeploymentFence,
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
			return await fence.mutate(() => api.createWorkersSubdomain(accountId, candidate));
		} catch (error) {
			if (!(error instanceof CloudflareApiError && error.status >= 400 && error.status < 500 && error.status !== 408)) throw error;
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
	const expectedRemote = await checkRemoteDeployment(input);
	input.onProgress?.('Preparing the server database…');
	const databaseId = await ensureD1Database(input.api, input.accountId, input.metadata);
	if (!databaseId) throw new Error('Cloudflare did not return the new D1 database ID');
	if (input.metadata.d1DatabaseId !== databaseId) {
		input.metadata.d1DatabaseId = databaseId;
		await input.onMetadataChanged();
	}

	const schemaInput = {
		api: input.api,
		accountId: input.accountId,
		databaseId,
		artifacts: input.artifacts,
	};
	await validateD1Schema(schemaInput);
	return withDeploymentFence({ api: input.api, accountId: input.accountId, databaseId,
		record: { worker: input.metadata.workerName, kind: 'update', version: input.artifacts.version, fingerprint: input.artifacts.fingerprint },
	}, async fence => {
		// Recheck after acquiring ownership: another device may have completed an
		// update after the initial read but before this attempt acquired the fence.
		if (await checkRemoteDeployment(input) !== expectedRemote) throw new Error('The server changed while this update was starting. Refresh its deployment status before authorizing another update.');
		await validateD1Schema(schemaInput);
		input.onProgress?.('Preparing the remote file bucket…');
		await ensureR2Bucket(input.api, input.accountId, input.metadata.r2BucketName, fence);
		input.onProgress?.('Initializing the database schema…');
		await fence.mutate(() => input.api.queryD1(input.accountId, databaseId, input.artifacts.d1Schema));
		input.onProgress?.('Uploading the Worker and web app to Cloudflare…');
		await fence.mutate(() => input.api.uploadWorker({
			accountId: input.accountId,
			workerName: input.metadata.workerName,
			artifacts: input.artifacts,
			d1DatabaseId: databaseId,
			r2BucketName: input.metadata.r2BucketName,
		}));
		input.onProgress?.('Configuring server maintenance…');
		await fence.mutate(() => input.api.updateWorkerSchedules(
			input.accountId,
			input.metadata.workerName,
			[CLOUDFLARE_MAINTENANCE_CRON],
		));

		input.onProgress?.('Enabling the server address…');
		const workersSubdomain = await ensureWorkersSubdomain(input.api, input.accountId, input.metadata, fence);
		if (input.metadata.workersSubdomain !== workersSubdomain) {
			input.metadata.workersSubdomain = workersSubdomain;
			await input.onMetadataChanged();
		}
		await fence.mutate(() => input.api.enableWorkerSubdomain(input.accountId, input.metadata.workerName));

		if (
			input.metadata.lastDeployedVersion !== input.artifacts.version
			|| input.metadata.lastDeployedFingerprint !== input.artifacts.fingerprint
		) {
			input.metadata.lastDeployedVersion = input.artifacts.version;
			input.metadata.lastDeployedFingerprint = input.artifacts.fingerprint;
			await input.onMetadataChanged();
		}
		return `https://${input.metadata.workerName}.${workersSubdomain}.workers.dev`;
	});
}
