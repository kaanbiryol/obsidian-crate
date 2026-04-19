import {
	type CloudflareCredentials,
	type R2Bucket,
	createD1Database,
	createR2Bucket,
	deployWorker,
	generateAuthToken,
	generateBucketName,
	generateWorkerName,
	getWorkerBindings,
	getWorkerSubdomain,
	listD1Databases,
	listR2Buckets,
	listWorkers,
	queryD1,
	redeployWorker,
	verifyCredentials,
} from './api';
import { getWorkerScript } from './worker-template';
import type {
	ProgressCallback,
	QuickSetupInput,
	QuickSetupResult,
	RedeployInput,
	WorkerTokenConfig,
} from './infrastructure-types';
import {
	computeTokenHash,
	registerTokenWithWorker,
	resolveConfigFromBindings,
	toCredentials,
	waitForWorkerReady,
} from './infrastructure-shared';

export async function quickSetup(
	input: QuickSetupInput,
	onProgress?: ProgressCallback
): Promise<QuickSetupResult> {
	const credentials = toCredentials(input.accountId, input.apiToken);
	if (!credentials.accountId || !credentials.apiToken) {
		throw new Error('Account ID and API token are required');
	}

	onProgress?.('Verifying Cloudflare credentials...');
	const valid = await verifyCredentials(credentials);
	if (!valid) {
		throw new Error('Invalid Cloudflare credentials');
	}

	if (!input.workerName?.trim() && !input.bucketName?.trim()) {
		try {
			const reconnectResult = await tryReconnectExisting(credentials, input, onProgress);
			if (reconnectResult) return reconnectResult;
		} catch {
			// Fall through to create-new logic
		}
	}

	onProgress?.('Checking R2 access...');
	let buckets: R2Bucket[];
	try {
		buckets = await listR2Buckets(credentials);
	} catch (error) {
		throw new Error(
			`Unable to access R2. Enable R2 in Cloudflare first. ${error instanceof Error ? error.message : ''}`.trim()
		);
	}

	const requestedBucket = input.bucketName?.trim() || generateBucketName();
	const requestedWorker = input.workerName?.trim() || generateWorkerName();

	let bucketCreated = false;
	if (!buckets.some((bucket) => bucket.name === requestedBucket)) {
		onProgress?.(`Creating R2 bucket ${requestedBucket}...`);
		await createR2Bucket(credentials, requestedBucket);
		bucketCreated = true;
	} else {
		onProgress?.(`Using existing R2 bucket ${requestedBucket}...`);
	}

	const authToken = generateAuthToken();

	onProgress?.('Creating D1 database...');
	const d1 = await createD1Database(credentials, `crate-${requestedWorker}`);

	onProgress?.(`Deploying worker ${requestedWorker}...`);
	const workerScript = getWorkerScript();
	const deployment = await deployWorker(credentials, requestedWorker, workerScript, {
		r2Bucket: requestedBucket,
		authToken,
		d1DatabaseId: d1.uuid,
		accountId: credentials.accountId,
		workerName: requestedWorker,
		bucketName: requestedBucket,
	});

	await waitForWorkerReady(deployment.url, authToken, onProgress);
	await registerTokenWithWorker(deployment.url, authToken, {
		deviceId: input.deviceId,
		deviceName: input.deviceName,
		platform: input.platform,
	});

	return {
		workerUrl: deployment.url,
		authToken,
		bucketName: requestedBucket,
		workerName: requestedWorker,
		databaseId: d1.uuid,
		bucketCreated,
	};
}

async function tryReconnectExisting(
	credentials: CloudflareCredentials,
	input: QuickSetupInput,
	onProgress?: ProgressCallback
): Promise<QuickSetupResult | null> {
	onProgress?.('Checking for existing crate infrastructure...');
	const workers = await listWorkers(credentials);
	const crateWorker = workers.find((worker) => worker.id.startsWith('crate-sync-'));
	if (!crateWorker) return null;

	onProgress?.(`Found existing worker ${crateWorker.id}, reading bindings...`);
	const bindings = await getWorkerBindings(credentials, crateWorker.id);
	const config = resolveConfigFromBindings(bindings);
	if (!config) return null;

	onProgress?.('Verifying existing resources...');
	const [buckets, databases] = await Promise.all([
		listR2Buckets(credentials),
		listD1Databases(credentials),
	]);

	const bucketExists = buckets.some((bucket) => bucket.name === config.bucketName);
	const databaseExists = databases.some((database) => database.uuid === config.databaseId);
	if (!bucketExists || !databaseExists) return null;

	const authToken = generateAuthToken();
	const tokenHash = await computeTokenHash(authToken);
	const tokenId = crypto.randomUUID();
	onProgress?.('Registering device token...');
	await queryD1(
		credentials,
		config.databaseId,
		'INSERT INTO auth_tokens (id, token_hash, device_id, device_name, platform, last_seen_at) VALUES (?, ?, NULLIF(?, \'\'), ?, NULLIF(?, \'\'), datetime(\'now\'))',
		[tokenId, tokenHash, input.deviceId || '', input.deviceName || 'plugin-reconnect', input.platform || '']
	);

	onProgress?.(`Updating worker ${crateWorker.id}...`);
	const workerScript = getWorkerScript();
	await redeployWorker(credentials, crateWorker.id, workerScript);

	const subdomain = await getWorkerSubdomain(credentials);
	const workerUrl = `https://${crateWorker.id}.${subdomain}.workers.dev`;

	return {
		workerUrl,
		authToken,
		bucketName: config.bucketName,
		workerName: crateWorker.id,
		databaseId: config.databaseId,
		bucketCreated: false,
	};
}

export async function redeployFromPlugin(
	input: RedeployInput,
	onProgress?: ProgressCallback
): Promise<void> {
	const credentials = toCredentials(input.accountId, input.apiToken);
	if (!credentials.accountId || !credentials.apiToken || !input.workerName.trim()) {
		throw new Error('Account ID, API token, and worker name are required');
	}

	onProgress?.('Verifying Cloudflare credentials...');
	const valid = await verifyCredentials(credentials);
	if (!valid) {
		throw new Error('Invalid Cloudflare credentials');
	}

	onProgress?.(`Redeploying worker ${input.workerName}...`);
	await redeployWorker(credentials, input.workerName.trim(), getWorkerScript());
}

export async function refreshWorkerAuthToken(
	credentials: CloudflareCredentials,
	config: WorkerTokenConfig,
): Promise<string> {
	const authToken = generateAuthToken();
	const workerScript = getWorkerScript();
	await deployWorker(credentials, config.workerName, workerScript, {
		r2Bucket: config.bucketName,
		authToken,
		d1DatabaseId: config.databaseId,
		accountId: credentials.accountId,
		workerName: config.workerName,
		bucketName: config.bucketName,
	});
	await registerTokenWithWorker(config.workerUrl, authToken);
	return authToken;
}
