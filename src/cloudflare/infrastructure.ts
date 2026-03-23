/**
 * Higher-level infrastructure workflows used by the plugin settings UI.
 */

import { requestUrl } from 'obsidian';
import {
	type CloudflareCredentials,
	type D1Database,
	type R2Bucket,
	type WorkerBinding,
	type WorkerScript,
	createD1Database,
	createR2Bucket,
	deleteD1Database,
	deleteR2Bucket,
	deleteWorker,
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

const PURGE_WORKER_SCRIPT = `
export default {
  async fetch(request, env) {
    if (request.headers.get('X-Auth-Token') !== env.AUTH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    let listed = await env.BUCKET.list();
    let deleted = 0;
    while (true) {
      for (const obj of listed.objects) {
        await env.BUCKET.delete(obj.key);
        deleted++;
      }
      if (!listed.truncated) break;
      listed = await env.BUCKET.list({ cursor: listed.cursor });
    }
    return new Response(JSON.stringify({ deleted }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
`.trim();

export type DiagnosticStatus = 'pass' | 'fail' | 'warn';

export interface DiagnosticResult {
	name: string;
	status: DiagnosticStatus;
	message: string;
}

export interface QuickSetupInput {
	accountId: string;
	apiToken: string;
	bucketName?: string;
	workerName?: string;
}

export interface QuickSetupResult {
	workerUrl: string;
	authToken: string;
	bucketName: string;
	workerName: string;
	databaseId: string;
	bucketCreated: boolean;
}

export interface RedeployInput {
	accountId: string;
	apiToken: string;
	workerName: string;
}

export interface DiagnosticsInput {
	workerUrl?: string;
	authToken?: string;
	accountId?: string;
	apiToken?: string;
	workerName?: string;
	bucketName?: string;
	databaseId?: string;
}

export interface ResetInput {
	accountId: string;
	apiToken: string;
	workerName?: string;
	bucketName?: string;
	databaseId?: string;
	includeCratePrefixed?: boolean;
}

export interface ResetResult {
	deleted: string[];
	failed: string[];
}

export interface CrateResources {
	buckets: R2Bucket[];
	workers: WorkerScript[];
	databases: D1Database[];
}

type ProgressCallback = (message: string) => void;

export async function computeTokenHash(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function waitForWorkerReady(
	workerUrl: string,
	authToken: string,
	onProgress?: ProgressCallback
): Promise<void> {
	const url = `${workerUrl.replace(/\/$/, '')}/health`;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: { 'Authorization': `Bearer ${authToken}` },
				throw: false,
			});
			if (response.status === 200) return;
		} catch {
			// Worker not ready yet
		}
		onProgress?.(`Waiting for worker to become available (${attempt + 1}/10)...`);
		await sleep(2000);
	}
	// Don't throw - let the caller proceed and handle errors naturally
}

async function registerTokenWithWorker(
	workerUrl: string,
	authToken: string,
	deviceName?: string
): Promise<void> {
	const tokenHash = await computeTokenHash(authToken);
	try {
		await requestUrl({
			url: `${workerUrl.replace(/\/$/, '')}/auth/tokens`,
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${authToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ token_hash: tokenHash, device_name: deviceName }),
		});
	} catch {
		// Best effort - AUTH_TOKEN binding provides fallback
	}
}

function toCredentials(accountId: string, apiToken: string): CloudflareCredentials {
	return { accountId: accountId.trim(), apiToken: apiToken.trim() };
}

function isValidUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

function isBucketNotEmptyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes('not empty') || message.includes('bucket not empty');
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveConfigFromBindings(bindings: WorkerBinding[]): { bucketName: string; databaseId: string } | null {
	let bucketName: string | undefined;
	let databaseId: string | undefined;

	for (const binding of bindings) {
		if (binding.type === 'plain_text' && binding.name === 'CF_BUCKET_NAME' && binding.text) {
			bucketName = binding.text;
		}
		if (binding.type === 'plain_text' && binding.name === 'CF_DATABASE_ID' && binding.text) {
			databaseId = binding.text;
		}
	}

	if (!bucketName || !databaseId) return null;
	return { bucketName, databaseId };
}

function collectResourcesFromWorkerBindings(
	bindings: WorkerBinding[],
	bucketNames: Set<string>,
	databaseIds: Set<string>
): void {
	for (const binding of bindings) {
		if (binding.type === 'plain_text' && binding.name === 'CF_BUCKET_NAME' && binding.text?.trim()) {
			bucketNames.add(binding.text.trim());
		}
		if (binding.type === 'plain_text' && binding.name === 'CF_DATABASE_ID' && binding.text?.trim()) {
			databaseIds.add(binding.text.trim());
		}
		if (binding.type === 'r2_bucket' && binding.bucket_name?.trim()) {
			bucketNames.add(binding.bucket_name.trim());
		}
		if (binding.type === 'd1' && binding.id?.trim()) {
			databaseIds.add(binding.id.trim());
		}
	}
}

export async function quickSetup(input: QuickSetupInput, onProgress?: ProgressCallback): Promise<QuickSetupResult> {
	const credentials = toCredentials(input.accountId, input.apiToken);
	if (!credentials.accountId || !credentials.apiToken) {
		throw new Error('Account ID and API token are required');
	}

	onProgress?.('Verifying Cloudflare credentials...');
	const valid = await verifyCredentials(credentials);
	if (!valid) {
		throw new Error('Invalid Cloudflare credentials');
	}

	// Try to reconnect to existing crate infrastructure (only when no manual names provided)
	if (!input.workerName?.trim() && !input.bucketName?.trim()) {
		try {
			const reconnectResult = await tryReconnectExisting(credentials, onProgress);
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
	await registerTokenWithWorker(deployment.url, authToken);

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
	onProgress?: ProgressCallback
): Promise<QuickSetupResult | null> {
	onProgress?.('Checking for existing crate infrastructure...');
	const workers = await listWorkers(credentials);
	const crateWorker = workers.find((w) => w.id.startsWith('crate-sync-'));
	if (!crateWorker) return null;

	onProgress?.(`Found existing worker ${crateWorker.id}, reading bindings...`);
	const bindings = await getWorkerBindings(credentials, crateWorker.id);
	const config = resolveConfigFromBindings(bindings);
	if (!config) return null;

	// Verify bucket and database still exist
	onProgress?.('Verifying existing resources...');
	const [buckets, databases] = await Promise.all([
		listR2Buckets(credentials),
		listD1Databases(credentials),
	]);

	const bucketExists = buckets.some((b) => b.name === config.bucketName);
	const databaseExists = databases.some((d) => d.uuid === config.databaseId);
	if (!bucketExists || !databaseExists) return null;

	// Register a new device token via D1 API (preserves existing tokens)
	const authToken = generateAuthToken();
	const tokenHash = await computeTokenHash(authToken);
	const tokenId = crypto.randomUUID();
	onProgress?.(`Registering device token...`);
	await queryD1(
		credentials,
		config.databaseId,
		"INSERT INTO auth_tokens (id, token_hash, device_name) VALUES (?, ?, ?)",
		[tokenId, tokenHash, 'plugin-reconnect']
	);

	// Code-only redeploy to ensure worker version matches plugin
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

export async function redeployFromPlugin(input: RedeployInput, onProgress?: ProgressCallback): Promise<void> {
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
	config: { workerUrl: string; workerName: string; bucketName: string; databaseId: string },
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

async function requestWorkerJson(
	url: string,
	authToken: string
): Promise<{ status: number; body: unknown }> {
	const response = await requestUrl({
		url,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${authToken}`,
		},
		throw: false,
	});

	return {
		status: response.status,
		body: response.json as unknown,
	};
}

export async function runDiagnostics(input: DiagnosticsInput): Promise<DiagnosticResult[]> {
	const results: DiagnosticResult[] = [];

	const workerUrl = input.workerUrl?.trim() || '';
	const workerToken = input.authToken?.trim() || '';

	if (workerUrl || workerToken) {
		if (!workerUrl || !workerToken) {
			results.push({
				name: 'Worker configuration',
				status: 'warn',
				message: 'Worker URL and auth token must both be provided for worker diagnostics.',
			});
		} else if (!isValidUrl(workerUrl)) {
			results.push({
				name: 'Worker URL',
				status: 'fail',
				message: 'Worker URL is invalid.',
			});
		} else {
			try {
				const health = await requestWorkerJson(`${workerUrl.replace(/\/$/, '')}/health`, workerToken);
				if (health.status === 200) {
					results.push({
						name: 'Worker health',
						status: 'pass',
						message: 'Worker is responding.',
					});

					const manifest = await requestWorkerJson(`${workerUrl.replace(/\/$/, '')}/sync/manifest`, workerToken);
					if (manifest.status === 200 && manifest.body && typeof manifest.body === 'object') {
						const files = (manifest.body as { files?: Record<string, unknown> }).files || {};
						results.push({
							name: 'Manifest access',
							status: 'pass',
							message: `Manifest is reachable (${Object.keys(files).length} files).`,
						});
					} else {
						const manifestError = (
							manifest.body && typeof manifest.body === 'object' && 'error' in manifest.body
								? (manifest.body as { error?: string }).error
								: null
						);
						results.push({
							name: 'Manifest access',
							status: 'fail',
							message: manifestError
								? `Manifest request failed with status ${manifest.status}: ${manifestError}`
								: `Manifest request failed with status ${manifest.status}.`,
						});
					}
				} else if (health.status === 401) {
					results.push({
						name: 'Worker health',
						status: 'fail',
						message: 'Authentication failed. Check the worker auth token.',
					});
				} else {
					results.push({
						name: 'Worker health',
						status: 'fail',
						message: `Health check failed with status ${health.status}.`,
					});
				}
			} catch (error) {
				results.push({
					name: 'Worker health',
					status: 'fail',
					message: `Unable to reach worker: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	const accountId = input.accountId?.trim() || '';
	const apiToken = input.apiToken?.trim() || '';

	if (accountId || apiToken) {
		if (!accountId || !apiToken) {
			results.push({
				name: 'Cloudflare credentials',
				status: 'warn',
				message: 'Account ID and API token must both be provided for Cloudflare diagnostics.',
			});
		} else {
			const credentials = toCredentials(accountId, apiToken);
			const valid = await verifyCredentials(credentials);
			results.push({
				name: 'Cloudflare credentials',
				status: valid ? 'pass' : 'fail',
				message: valid ? 'Credentials verified.' : 'Credentials are invalid.',
			});

			if (valid) {
				const [buckets, workers, databases] = await Promise.all([
					listR2Buckets(credentials),
					listWorkers(credentials),
					listD1Databases(credentials),
				]);

				results.push({
					name: 'R2 access',
					status: 'pass',
					message: `Accessible. ${buckets.length} bucket(s) found.`,
				});
				results.push({
					name: 'Workers access',
					status: 'pass',
					message: `Accessible. ${workers.length} worker(s) found.`,
				});
				results.push({
					name: 'D1 access',
					status: 'pass',
					message: `Accessible. ${databases.length} database(s) found.`,
				});

				if (input.workerName) {
					const exists = workers.some((worker) => worker.id === input.workerName);
					results.push({
						name: 'Configured worker',
						status: exists ? 'pass' : 'warn',
						message: exists
							? `Worker ${input.workerName} exists.`
							: `Worker ${input.workerName} was not found.`,
					});
				}

				if (input.bucketName) {
					const exists = buckets.some((bucket) => bucket.name === input.bucketName);
					results.push({
						name: 'Configured bucket',
						status: exists ? 'pass' : 'warn',
						message: exists
							? `Bucket ${input.bucketName} exists.`
							: `Bucket ${input.bucketName} was not found.`,
					});
				}

				if (input.databaseId) {
					const exists = databases.some((database) => database.uuid === input.databaseId);
					results.push({
						name: 'Configured database',
						status: exists ? 'pass' : 'warn',
						message: exists
							? `Database ${input.databaseId} exists.`
							: `Database ${input.databaseId} was not found.`,
					});
				}
			}
		}
	}

	if (results.length === 0) {
		results.push({
			name: 'Diagnostics',
			status: 'warn',
			message: 'No diagnostics ran. Provide worker and/or Cloudflare credentials.',
		});
	}

	return results;
}

export async function discoverCrateResources(input: {
	accountId: string;
	apiToken: string;
	includeCratePrefixed?: boolean;
	workerName?: string;
	bucketName?: string;
	databaseId?: string;
}): Promise<CrateResources> {
	const credentials = toCredentials(input.accountId, input.apiToken);

	const [allBuckets, allWorkers, allDatabases] = await Promise.all([
		listR2Buckets(credentials),
		listWorkers(credentials),
		listD1Databases(credentials),
	]);

	const includeCratePrefixed = input.includeCratePrefixed !== false;

	const bucketNames = new Set<string>();
	const workerNames = new Set<string>();
	const databaseIds = new Set<string>();

	if (includeCratePrefixed) {
		for (const bucket of allBuckets) {
			if (bucket.name.startsWith('crate-')) {
				bucketNames.add(bucket.name);
			}
		}
		for (const worker of allWorkers) {
			if (worker.id.startsWith('crate-')) {
				workerNames.add(worker.id);
			}
		}
		for (const database of allDatabases) {
			if (database.name.startsWith('crate-')) {
				databaseIds.add(database.uuid);
			}
		}
	}

	if (input.bucketName) {
		bucketNames.add(input.bucketName);
	}
	if (input.workerName) {
		workerNames.add(input.workerName);
	}
	if (input.databaseId) {
		databaseIds.add(input.databaseId);
	}

	const matchedWorkers = allWorkers.filter((worker) => workerNames.has(worker.id));
	if (matchedWorkers.length > 0) {
		await Promise.all(matchedWorkers.map(async (worker) => {
			try {
				const bindings = await getWorkerBindings(credentials, worker.id);
				collectResourcesFromWorkerBindings(bindings, bucketNames, databaseIds);
			} catch {
				// Best effort. We can still proceed with known names.
			}
		}));
	}

	return {
		buckets: allBuckets.filter((bucket) => bucketNames.has(bucket.name)),
		workers: allWorkers.filter((worker) => workerNames.has(worker.id)),
		databases: allDatabases.filter((database) => databaseIds.has(database.uuid)),
	};
}

interface PurgeResult {
	purgedCount: number;
	tempWorkerName: string;
}

async function emptyBucketWithPurgeWorker(
	credentials: CloudflareCredentials,
	bucketName: string
): Promise<PurgeResult> {
	const tempWorkerName = `crate-purge-${Math.random().toString(36).slice(2, 8)}`;
	const authToken = generateAuthToken();

	const deployment = await deployWorker(credentials, tempWorkerName, PURGE_WORKER_SCRIPT, {
		r2Bucket: bucketName,
		authToken,
		skipDurableObjects: true,
	});

	for (let attempt = 0; attempt < 5; attempt++) {
		await sleep(2000 * (attempt + 1));

		try {
			const response = await requestUrl({
				url: deployment.url,
				method: 'GET',
				headers: {
					'X-Auth-Token': authToken,
				},
				throw: false,
			});

			if (response.status >= 200 && response.status < 300 && response.json && typeof response.json === 'object') {
				const deleted = (response.json as { deleted?: number }).deleted;
				return { purgedCount: typeof deleted === 'number' ? deleted : 0, tempWorkerName };
			}
		} catch {
			// Worker propagation can take a few attempts.
		}
	}

	throw new Error('Purge worker did not respond after multiple attempts.');
}

export async function resetInfrastructure(input: ResetInput, onProgress?: ProgressCallback): Promise<ResetResult> {
	const credentials = toCredentials(input.accountId, input.apiToken);
	const deleted: string[] = [];
	const failed: string[] = [];

	onProgress?.('Discovering Cloudflare resources...');
	const resources = await discoverCrateResources({
		accountId: credentials.accountId,
		apiToken: credentials.apiToken,
		includeCratePrefixed: input.includeCratePrefixed,
		workerName: input.workerName,
		bucketName: input.bucketName,
		databaseId: input.databaseId,
	});

	for (const worker of resources.workers) {
		onProgress?.(`Deleting worker ${worker.id}...`);
		try {
			await deleteWorker(credentials, worker.id);
			deleted.push(`Worker ${worker.id}`);
		} catch (error) {
			failed.push(`Worker ${worker.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	for (const database of resources.databases) {
		onProgress?.(`Deleting D1 database ${database.name}...`);
		try {
			await deleteD1Database(credentials, database.uuid);
			deleted.push(`D1 database ${database.name}`);
		} catch (error) {
			failed.push(`D1 database ${database.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const tempWorkerNames: string[] = [];

	for (const bucket of resources.buckets) {
		onProgress?.(`Deleting bucket ${bucket.name}...`);
		try {
			await deleteR2Bucket(credentials, bucket.name);
			deleted.push(`R2 bucket ${bucket.name}`);
		} catch (error) {
			if (isBucketNotEmptyError(error)) {
				try {
					onProgress?.(`Emptying bucket ${bucket.name}...`);
					const { purgedCount, tempWorkerName } = await emptyBucketWithPurgeWorker(credentials, bucket.name);
					tempWorkerNames.push(tempWorkerName);
					onProgress?.(`Deleted ${purgedCount} object(s) from ${bucket.name}; retrying bucket delete...`);
					await deleteR2Bucket(credentials, bucket.name);
					deleted.push(`R2 bucket ${bucket.name}`);
				} catch (purgeError) {
					failed.push(
						`R2 bucket ${bucket.name}: ${purgeError instanceof Error ? purgeError.message : String(purgeError)}`
					);
				}
			} else {
				failed.push(`R2 bucket ${bucket.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	for (const tempName of tempWorkerNames) {
		try {
			await deleteWorker(credentials, tempName);
		} catch {
			// Best effort cleanup of temporary purge workers.
		}
	}

	return { deleted, failed };
}
