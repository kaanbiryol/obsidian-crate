import { requestUrl } from 'obsidian';
import {
	deleteD1Database,
	deleteR2Bucket,
	deleteWorker,
	deployWorker,
	generateAuthToken,
	generateWorkerName,
	type CloudflareCredentials,
} from './api';
import { errorMessage } from '../plugin/logger';
import { discoverCrateResources } from './infrastructure-discovery';
import type {
	ProgressCallback,
	ResetInput,
	ResetResult,
} from './infrastructure-types';
import {
	isBucketNotEmptyError,
	sleep,
	toCredentials,
} from './infrastructure-shared';

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

interface PurgeResult {
	purgedCount: number;
	tempWorkerName: string;
}

async function emptyBucketWithPurgeWorker(
	credentials: CloudflareCredentials,
	bucketName: string
): Promise<PurgeResult> {
	const tempWorkerName = generateWorkerName('crate-purge');
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

			if (
				response.status >= 200
				&& response.status < 300
				&& response.json
				&& typeof response.json === 'object'
			) {
				const deleted = (response.json as { deleted?: number }).deleted;
				return { purgedCount: typeof deleted === 'number' ? deleted : 0, tempWorkerName };
			}
		} catch {
			// Worker propagation can take a few attempts.
		}
	}

	throw new Error('Purge worker did not respond after multiple attempts.');
}

export async function resetInfrastructure(
	input: ResetInput,
	onProgress?: ProgressCallback
): Promise<ResetResult> {
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
			failed.push(`Worker ${worker.id}: ${errorMessage(error)}`);
		}
	}

	for (const database of resources.databases) {
		onProgress?.(`Deleting D1 database ${database.name}...`);
		try {
			await deleteD1Database(credentials, database.uuid);
			deleted.push(`D1 database ${database.name}`);
		} catch (error) {
			failed.push(`D1 database ${database.name}: ${errorMessage(error)}`);
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
					const { purgedCount, tempWorkerName } = await emptyBucketWithPurgeWorker(
						credentials,
						bucket.name,
					);
					tempWorkerNames.push(tempWorkerName);
					onProgress?.(`Deleted ${purgedCount} object(s) from ${bucket.name}; retrying bucket delete...`);
					await deleteR2Bucket(credentials, bucket.name);
					deleted.push(`R2 bucket ${bucket.name}`);
				} catch (purgeError) {
					failed.push(`R2 bucket ${bucket.name}: ${errorMessage(purgeError)}`);
				}
			} else {
				failed.push(`R2 bucket ${bucket.name}: ${errorMessage(error)}`);
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
