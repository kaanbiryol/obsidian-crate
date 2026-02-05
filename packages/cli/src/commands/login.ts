/**
 * `crate login` command - Authenticate with Cloudflare via OAuth
 */

import { performOAuthFlow } from '../cloudflare/oauth.js';
import { saveCredentials, loadCredentials } from '../config.js';

export async function loginCommand(): Promise<void> {
	console.log('\n🔐 Cloudflare Login\n');

	// Check if already logged in
	const existing = loadCredentials();
	if (existing) {
		console.log('You are already logged in.');
		console.log(`Account ID: ${existing.accountId}`);
		console.log('\nRun `crate logout` first if you want to switch accounts.\n');
		return;
	}

	try {
		// Dynamic import of 'open' package
		const openModule = await import('open');
		const open = openModule.default || openModule;

		console.log('Starting OAuth flow...');
		const result = await performOAuthFlow(async (url: string) => {
			await open(url);
		});

		// Save credentials
		saveCredentials(result.accountId, result.tokens);

		console.log('\n✅ Successfully logged in!');
		console.log(`   Account ID: ${result.accountId}`);
		console.log('\nYou can now run `crate init` to set up your infrastructure.\n');
	} catch (error) {
		console.error('\n❌ Login failed:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
