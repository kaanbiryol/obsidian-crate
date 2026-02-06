/**
 * `crate update` command - Updates an existing worker with new code
 */

import {
	CloudflareCredentials,
	verifyCredentials,
	redeployWorker,
} from '../cloudflare/api.js';
import { refreshAccessToken } from '../cloudflare/oauth.js';
import { getWorkerScript } from '../worker-template.js';
import { loadCredentials, saveCredentials, loadDeploymentConfig } from '../config.js';

export interface UpdateOptions {
	workerName?: string;
	accountId?: string;
	apiToken?: string;
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
	console.log('\n⚙️  Obsidian Crate - Update Worker\n');

	// Load deployment config (must exist)
	const deploymentConfig = loadDeploymentConfig();

	if (!deploymentConfig) {
		console.error('❌ No deployment config found.');
		console.error('   Run `crate init` first to set up infrastructure.\n');
		process.exit(1);
	}

	const workerName = options.workerName || deploymentConfig.workerName;

	// Resolve credentials
	const credentials = await resolveCredentials(options);

	if (!credentials) {
		console.error('❌ No Cloudflare credentials found.');
		console.error('   Run `crate login` or provide --account-id and --api-token.\n');
		process.exit(1);
	}

	try {
		// Redeploy worker with new code, preserving existing bindings
		console.log(`🚀 Updating worker: ${workerName}...`);
		const workerScript = getWorkerScript();
		await redeployWorker(credentials, workerName, workerScript);
		console.log('✅ Worker updated successfully!\n');
	} catch (error) {
		console.error('\n❌ Update failed:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

async function resolveCredentials(options: UpdateOptions): Promise<CloudflareCredentials | null> {
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

	let credentials: CloudflareCredentials = {
		accountId: stored.accountId,
		apiToken: stored.accessToken,
	};

	console.log('📡 Verifying credentials...');
	const valid = await verifyCredentials(credentials);

	if (valid) {
		return credentials;
	}

	// Token expired — try refreshing
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
