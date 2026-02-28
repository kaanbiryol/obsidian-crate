/**
 * `crate reset` command - Tears down all Crate Cloudflare infrastructure
 */

import { createInterface } from 'readline';
import {
	CloudflareCredentials,
	verifyCredentials,
	listR2Buckets,
	listWorkers,
	listD1Databases,
	deleteR2Bucket,
	deleteWorker,
	deleteD1Database,
	deployWorker,
	generateAuthToken,
	getWorkerSubdomain,
} from '../cloudflare/api.js';
import { refreshAccessToken } from '../cloudflare/oauth.js';
import { loadCredentials, saveCredentials, loadDeploymentConfig, clearDeploymentConfig } from '../config.js';

export interface ResetOptions {
	accountId?: string;
	apiToken?: string;
	yes?: boolean;
}

export async function resetCommand(options: ResetOptions): Promise<void> {
	console.log('\n🗑️  Crate - Reset Infrastructure\n');

	const credentials = await resolveCredentials(options);

	if (!credentials) {
		console.error('❌ No Cloudflare credentials found.');
		console.error('   Run `crate login` or provide --account-id and --api-token.\n');
		process.exit(1);
	}

	// Discover resources in parallel
	console.log('🔍 Discovering Crate resources...\n');

	const [buckets, workers, databases] = await Promise.all([
		listR2Buckets(credentials).catch((err) => {
			console.warn('⚠️  Failed to list R2 buckets:', err instanceof Error ? err.message : err);
			return [] as Awaited<ReturnType<typeof listR2Buckets>>;
		}),
		listWorkers(credentials).catch((err) => {
			console.warn('⚠️  Failed to list Workers:', err instanceof Error ? err.message : err);
			return [] as Awaited<ReturnType<typeof listWorkers>>;
		}),
		listD1Databases(credentials).catch((err) => {
			console.warn('⚠️  Failed to list D1 databases:', err instanceof Error ? err.message : err);
			return [] as Awaited<ReturnType<typeof listD1Databases>>;
		}),
	]);

	// Filter to crate-* resources
	const deploymentConfig = loadDeploymentConfig();

	const crateBuckets = buckets.filter((b) => b.name.startsWith('crate-'));
	const crateWorkers = workers.filter((w) => w.id.startsWith('crate-'));
	const crateDatabases = databases.filter((d) => d.name.startsWith('crate-'));

	// Also include deployment config resources that may not match crate-* prefix
	if (deploymentConfig) {
		if (deploymentConfig.bucketName && !crateBuckets.some((b) => b.name === deploymentConfig.bucketName)) {
			const match = buckets.find((b) => b.name === deploymentConfig.bucketName);
			if (match) crateBuckets.push(match);
		}
		if (deploymentConfig.workerName && !crateWorkers.some((w) => w.id === deploymentConfig.workerName)) {
			const match = workers.find((w) => w.id === deploymentConfig.workerName);
			if (match) crateWorkers.push(match);
		}
		if (deploymentConfig.databaseId && !crateDatabases.some((d) => d.uuid === deploymentConfig.databaseId)) {
			const match = databases.find((d) => d.uuid === deploymentConfig.databaseId);
			if (match) crateDatabases.push(match);
		}
	}

	const totalResources = crateBuckets.length + crateWorkers.length + crateDatabases.length;

	if (totalResources === 0 && !deploymentConfig) {
		console.log('✅ No Crate resources found. Nothing to reset.\n');
		return;
	}

	// Display found resources
	if (crateBuckets.length > 0) {
		console.log(`  R2 Buckets (${crateBuckets.length}):`);
		for (const b of crateBuckets) console.log(`    - ${b.name}`);
	}
	if (crateWorkers.length > 0) {
		console.log(`  Workers (${crateWorkers.length}):`);
		for (const w of crateWorkers) console.log(`    - ${w.id}`);
	}
	if (crateDatabases.length > 0) {
		console.log(`  D1 Databases (${crateDatabases.length}):`);
		for (const d of crateDatabases) console.log(`    - ${d.name} (${d.uuid})`);
	}
	if (deploymentConfig) {
		console.log('  Local config:');
		console.log('    - ~/.crate/deployment.json');
	}
	console.log();

	// Confirm
	if (!options.yes) {
		const confirmed = await confirm('⚠️  This will permanently delete these resources. Continue? (y/N) ');
		if (!confirmed) {
			console.log('\nReset cancelled.\n');
			return;
		}
		console.log();
	}

	// Delete in order: buckets, workers, databases, local config
	let succeeded = 0;
	let failed = 0;

	for (const bucket of crateBuckets) {
		try {
			process.stdout.write(`  Deleting R2 bucket: ${bucket.name}...`);
			await deleteR2Bucket(credentials, bucket.name);
			console.log(' ✅');
			succeeded++;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.toLowerCase().includes('not empty') || message.toLowerCase().includes('bucket not empty')) {
				console.log(' not empty, emptying...');
				try {
					const count = await emptyR2Bucket(credentials, bucket.name);
					console.log(`    Purged ${count} object(s) via temporary worker`);
					await deleteR2Bucket(credentials, bucket.name);
					console.log(`  Deleted R2 bucket: ${bucket.name} ✅`);
					succeeded++;
				} catch (emptyErr) {
					console.log(`    ❌ Failed to empty: ${emptyErr instanceof Error ? emptyErr.message : emptyErr}`);
					console.log(`    Empty it via the Cloudflare dashboard, then re-run \`crate reset\`.`);
					failed++;
				}
			} else {
				console.log(` ❌ ${message}`);
				failed++;
			}
		}
	}

	for (const worker of crateWorkers) {
		try {
			process.stdout.write(`  Deleting Worker: ${worker.id}...`);
			await deleteWorker(credentials, worker.id);
			console.log(' ✅');
			succeeded++;
		} catch (err) {
			console.log(` ❌ ${err instanceof Error ? err.message : err}`);
			failed++;
		}
	}

	for (const db of crateDatabases) {
		try {
			process.stdout.write(`  Deleting D1 database: ${db.name}...`);
			await deleteD1Database(credentials, db.uuid);
			console.log(' ✅');
			succeeded++;
		} catch (err) {
			console.log(` ❌ ${err instanceof Error ? err.message : err}`);
			failed++;
		}
	}

	if (deploymentConfig) {
		clearDeploymentConfig();
		console.log('  Removed local deployment config ✅');
	}

	// Summary
	console.log();
	if (failed === 0) {
		console.log(`✅ Reset complete. ${succeeded} resource(s) deleted.\n`);
	} else {
		console.log(`⚠️  Reset finished with issues: ${succeeded} deleted, ${failed} failed.\n`);
	}
}

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emptyR2Bucket(
	credentials: CloudflareCredentials,
	bucketName: string
): Promise<number> {
	const tempName = `crate-purge-${Math.random().toString(36).substring(2, 8)}`;
	const authToken = generateAuthToken();

	try {
		const deployment = await deployWorker(credentials, tempName, PURGE_WORKER_SCRIPT, {
			r2Bucket: bucketName,
			authToken,
		});

		// Retry — worker may take a moment to be available on workers.dev
		for (let attempt = 0; attempt < 5; attempt++) {
			await sleep(2000 * (attempt + 1));
			try {
				const response = await fetch(deployment.url, {
					headers: { 'X-Auth-Token': authToken },
				});
				if (response.ok) {
					const result = (await response.json()) as { deleted: number };
					return result.deleted;
				}
			} catch {
				// Worker not ready yet, retry
			}
		}

		throw new Error('Purge worker did not respond after multiple attempts');
	} finally {
		try {
			await deleteWorker(credentials, tempName);
		} catch {
			// Best effort cleanup
		}
	}
}

async function confirm(prompt: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
		});
	});
}

async function resolveCredentials(options: ResetOptions): Promise<CloudflareCredentials | null> {
	if (options.accountId && options.apiToken) {
		return { accountId: options.accountId, apiToken: options.apiToken };
	}

	const envAccountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
	const envApiToken = process.env['CLOUDFLARE_API_TOKEN'];

	if (envAccountId && envApiToken) {
		return { accountId: envAccountId, apiToken: envApiToken };
	}

	const stored = loadCredentials();
	if (!stored) {
		return null;
	}

	const credentials: CloudflareCredentials = {
		accountId: stored.accountId,
		apiToken: stored.accessToken,
	};

	console.log('📡 Verifying credentials...');
	const valid = await verifyCredentials(credentials);

	if (valid) {
		return credentials;
	}

	if (stored.refreshToken) {
		console.log('🔄 Access token expired, refreshing...');
		try {
			const newTokens = await refreshAccessToken(stored.refreshToken);
			saveCredentials(stored.accountId, {
				accessToken: newTokens.accessToken,
				refreshToken: newTokens.refreshToken,
				expiresAt: newTokens.expiresAt,
			});
			console.log('✅ Token refreshed!\n');
			return { accountId: stored.accountId, apiToken: newTokens.accessToken };
		} catch (error) {
			console.error('❌ Token refresh failed:', error instanceof Error ? error.message : error);
			console.error('   Run `crate login` to re-authenticate.\n');
			return null;
		}
	}

	console.error('❌ Access token expired and no refresh token available.');
	console.error('   Run `crate login` to re-authenticate.\n');
	return null;
}
