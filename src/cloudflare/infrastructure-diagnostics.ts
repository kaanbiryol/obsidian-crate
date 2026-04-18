import {
	listD1Databases,
	listR2Buckets,
	listWorkers,
	verifyCredentials,
} from './api';
import { errorMessage } from '../plugin/logger';
import type {
	DiagnosticResult,
	DiagnosticsInput,
} from './infrastructure-types';
import {
	requestWorkerJson,
	toCredentials,
} from './infrastructure-shared';
import { normalizeWorkerUrl } from '../sync/worker-url';

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
		} else {
			const normalizedWorkerUrl = normalizeWorkerUrl(workerUrl);
			if (!normalizedWorkerUrl) {
				results.push({
					name: 'Worker URL',
					status: 'fail',
					message: 'Worker URL must use HTTPS (or localhost over HTTP) and must not include credentials, query parameters, or fragments.',
				});
			} else {
				try {
					const health = await requestWorkerJson(`${normalizedWorkerUrl}/health`, workerToken);
					if (health.status === 200) {
						results.push({
							name: 'Worker health',
							status: 'pass',
							message: 'Worker is responding.',
						});

						const manifest = await requestWorkerJson(
							`${normalizedWorkerUrl}/sync/manifest`,
							workerToken,
						);
						if (manifest.status === 200 && manifest.body && typeof manifest.body === 'object') {
							const files = (manifest.body as { files?: Record<string, unknown> }).files || {};
							results.push({
								name: 'Manifest access',
								status: 'pass',
								message: `Manifest is reachable (${Object.keys(files).length} files).`,
							});
						} else {
							const manifestError = (
								manifest.body
								&& typeof manifest.body === 'object'
								&& 'error' in manifest.body
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
						message: `Unable to reach worker: ${errorMessage(error)}`,
					});
				}
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
