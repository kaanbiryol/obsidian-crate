/**
 * `crate deploy` command - Redeploys the worker script to an existing worker
 */

import {
	CloudflareCredentials,
	verifyCredentials,
	redeployWorker,
} from '../cloudflare/api.js';
import { refreshAccessToken } from '../cloudflare/oauth.js';
import { getWorkerScript } from '../worker-template.js';
import { loadCredentials, saveCredentials, loadDeploymentConfig } from '../config.js';

export interface DeployOptions {
	workerName?: string;
	accountId?: string;
	apiToken?: string;
}

export async function deployCommand(options: DeployOptions): Promise<void> {
	console.log('\n⚙️  Obsidian Crate - Deploy Worker\n');

	// Resolve worker name
	const deploymentConfig = loadDeploymentConfig();
	const workerName = options.workerName || deploymentConfig?.workerName;

	if (!workerName) {
		console.error('❌ No worker name specified.');
		console.error('   Provide --worker-name or run `crate init` first.\n');
		process.exit(1);
	}

	// Resolve credentials
	const credentials = await resolveCredentials(options);

	if (!credentials) {
		console.error('❌ No Cloudflare credentials found.');
		console.error('   Run `crate login` or provide --account-id and --api-token.\n');
		process.exit(1);
	}

	// Deploy
	try {
		console.log(`🚀 Deploying worker: ${workerName}...`);
		const workerScript = getWorkerScript();
		await redeployWorker(credentials, workerName, workerScript);
		console.log('✅ Worker redeployed successfully!\n');
	} catch (error) {
		console.error('\n❌ Deploy failed:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

async function resolveCredentials(options: DeployOptions): Promise<CloudflareCredentials | null> {
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
