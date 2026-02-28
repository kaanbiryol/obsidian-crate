/**
 * `crate init` command - Sets up Cloudflare infrastructure for Crate
 */

import inquirer from 'inquirer';
import {
	CloudflareCredentials,
	verifyCredentials,
	listR2Buckets,
	createR2Bucket,
	createD1Database,
	deployWorker,
	generateAuthToken,
	generateBucketName,
} from '../cloudflare/api.js';
import { getWorkerScript } from '../worker-template.js';
import { loadCredentials, saveCredentials, saveDeploymentConfig } from '../config.js';
import { performOAuthFlow, refreshAccessToken } from '../cloudflare/oauth.js';

export interface InitOptions {
	accountId?: string;
	apiToken?: string;
	bucketName?: string;
	workerName?: string;
}

export interface InitResult {
	workerUrl: string;
	authToken: string;
	bucketName: string;
	workerName: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
	console.log('\n🚀 Crate - Setup\n');
	console.log('This will create the Cloudflare infrastructure for syncing your vault.\n');

	// Gather credentials
	const credentials = await gatherCredentials(options);

	// Verify credentials
	console.log('\n📡 Verifying Cloudflare credentials...');
	const valid = await verifyCredentials(credentials);
	if (!valid) {
		console.error('❌ Invalid Cloudflare credentials. Please check your API token and try again.');
		process.exit(1);
	}
	console.log('✅ Credentials verified!\n');

	// Check if R2 is enabled
	await ensureR2Enabled(credentials);

	// Get configuration
	const config = await gatherConfiguration(options);

	try {
		// Create R2 bucket
		console.log(`\n📦 Creating R2 bucket: ${config.bucketName}...`);
		await createR2Bucket(credentials, config.bucketName);
		console.log('✅ R2 bucket created!\n');

		// Generate auth token
		const authToken = generateAuthToken();

		// Create D1 database
		console.log('🗄️  Creating D1 database...');
		const d1 = await createD1Database(credentials, `crate-${config.workerName}`);
		console.log('✅ D1 database created!\n');

		// Deploy worker
		console.log(`⚙️  Deploying Worker: ${config.workerName}...`);
		const workerScript = getWorkerScript();
		const deployment = await deployWorker(credentials, config.workerName, workerScript, {
			r2Bucket: config.bucketName,
			authToken: authToken,
			d1DatabaseId: d1.uuid,
			accountId: credentials.accountId,
			workerName: config.workerName,
			bucketName: config.bucketName,
		});
		console.log('✅ Worker deployed!\n');

		// Output configuration
		const result: InitResult = {
			workerUrl: deployment.url,
			authToken: authToken,
			bucketName: config.bucketName,
			workerName: config.workerName,
		};

		// Save deployment config for future `crate deploy`
		saveDeploymentConfig({
			workerName: config.workerName,
			bucketName: config.bucketName,
			workerUrl: result.workerUrl,
			databaseId: d1.uuid,
		});

		outputResult(result);
	} catch (error) {
		console.error('\n❌ Setup failed:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

async function ensureR2Enabled(credentials: CloudflareCredentials): Promise<void> {
	try {
		await listR2Buckets(credentials);
	} catch {
		// R2 not enabled — prompt the user
		console.log('⚠️  R2 Object Storage is not enabled on your Cloudflare account.');
		console.log('   Please enable it at: https://dash.cloudflare.com → R2 Object Storage\n');

		const { enabled } = await inquirer.prompt<{ enabled: boolean }>([
			{
				type: 'confirm',
				name: 'enabled',
				message: 'Have you enabled R2 from the Cloudflare dashboard?',
				default: false,
			},
		]);

		if (!enabled) {
			console.log('\nPlease enable R2 and run `crate init` again.');
			process.exit(0);
		}

		// Verify it actually works now
		try {
			await listR2Buckets(credentials);
		} catch {
			console.error('❌ R2 is still not enabled. Please enable it and run `crate init` again.');
			process.exit(1);
		}

		console.log('✅ R2 is enabled!\n');
	}
}

async function gatherCredentials(options: InitOptions): Promise<CloudflareCredentials> {
	// Check for CLI options first
	if (options.accountId && options.apiToken) {
		return {
			accountId: options.accountId,
			apiToken: options.apiToken,
		};
	}

	// Check for environment variables
	const envAccountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
	const envApiToken = process.env['CLOUDFLARE_API_TOKEN'];

	if (envAccountId && envApiToken) {
		console.log('Using credentials from environment variables.\n');
		return {
			accountId: envAccountId,
			apiToken: envApiToken,
		};
	}

	// Check for stored credentials from OAuth login
	const stored = loadCredentials();
	if (stored) {
		console.log('Using stored credentials from `crate login`.\n');

		let credentials: CloudflareCredentials = {
			accountId: stored.accountId,
			apiToken: stored.accessToken,
		};

		const valid = await verifyCredentials(credentials);
		if (valid) return credentials;

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
				console.log('⚠️  Token refresh failed, falling back to re-authentication.\n');
			}
		} else {
			console.log('⚠️  Stored token expired, falling back to re-authentication.\n');
		}
	}

	// No credentials found - offer options
	const { authMethod } = await inquirer.prompt<{ authMethod: 'browser' | 'manual' }>([
		{
			type: 'list',
			name: 'authMethod',
			message: 'How would you like to authenticate?',
			choices: [
				{ name: 'Login with browser (recommended)', value: 'browser' },
				{ name: 'Enter API token manually', value: 'manual' },
			],
		},
	]);

	if (authMethod === 'browser') {
		try {
			const openModule = await import('open');
			const open = openModule.default || openModule;
			console.log('\nStarting OAuth flow...');
			const result = await performOAuthFlow(async (url: string) => {
				await open(url);
			});

			// Save credentials for future use
			saveCredentials(result.accountId, result.tokens);
			console.log('\n✅ Logged in and credentials saved!\n');

			return {
				accountId: result.accountId,
				apiToken: result.tokens.accessToken,
			};
		} catch (error) {
			console.error('\n❌ OAuth login failed:', error instanceof Error ? error.message : error);
			console.log('Falling back to manual entry.\n');
		}
	}

	// Manual entry fallback
	console.log('Please provide your Cloudflare credentials.');
	console.log('You can create an API token at: https://dash.cloudflare.com/profile/api-tokens\n');
	console.log('Required permissions: Account.Workers Scripts (Edit), Account.R2 (Edit)\n');

	const answers = await inquirer.prompt<{ accountId: string; apiToken: string }>([
		{
			type: 'input',
			name: 'accountId',
			message: 'Cloudflare Account ID:',
			default: options.accountId || envAccountId,
			validate: (input: string) => input.length > 0 || 'Account ID is required',
		},
		{
			type: 'password',
			name: 'apiToken',
			message: 'Cloudflare API Token:',
			validate: (input: string) => input.length > 0 || 'API Token is required',
		},
	]);

	return {
		accountId: answers.accountId,
		apiToken: answers.apiToken,
	};
}

async function gatherConfiguration(options: InitOptions): Promise<{ bucketName: string; workerName: string }> {
	const defaultBucketName = generateBucketName();
	const defaultWorkerName = `crate-sync-${Math.random().toString(36).substring(2, 8)}`;

	if (options.bucketName && options.workerName) {
		return {
			bucketName: options.bucketName,
			workerName: options.workerName,
		};
	}

	const answers = await inquirer.prompt<{ bucketName: string; workerName: string }>([
		{
			type: 'input',
			name: 'bucketName',
			message: 'R2 Bucket name:',
			default: options.bucketName || defaultBucketName,
			validate: (input: string) => {
				if (input.length < 3) return 'Bucket name must be at least 3 characters';
				if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(input)) {
					return 'Bucket name must be lowercase alphanumeric with hyphens, not starting/ending with hyphen';
				}
				return true;
			},
		},
		{
			type: 'input',
			name: 'workerName',
			message: 'Worker name:',
			default: options.workerName || defaultWorkerName,
			validate: (input: string) => {
				if (input.length < 3) return 'Worker name must be at least 3 characters';
				if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(input)) {
					return 'Worker name must be lowercase alphanumeric with hyphens, not starting/ending with hyphen';
				}
				return true;
			},
		},
	]);

	return answers;
}

function outputResult(result: InitResult): void {
	console.log('═'.repeat(60));
	console.log('\n🎉 Setup complete!\n');
	console.log('Copy these values into Crate settings:\n');
	console.log('─'.repeat(60));
	console.log('Worker URL');
	console.log(result.workerUrl);
	console.log('');
	console.log('Auth token');
	console.log(result.authToken);

	console.log('─'.repeat(60));
	console.log('\n📝 Details:');
	console.log(`   R2 Bucket: ${result.bucketName}`);
	console.log(`   Worker: ${result.workerName}`);
	console.log(`   Worker URL: ${result.workerUrl}`);
	console.log('\n⚠️  Keep your auth token secret! Anyone with it can access your vault.\n');
}
