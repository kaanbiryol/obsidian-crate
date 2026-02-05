/**
 * `crate logout` command - Clear stored Cloudflare credentials
 */

import { clearCredentials, loadCredentials, getCredentialsPath } from '../config.js';

export async function logoutCommand(): Promise<void> {
	console.log('\n🔓 Cloudflare Logout\n');

	const existing = loadCredentials();
	if (!existing) {
		console.log('You are not currently logged in.\n');
		return;
	}

	const cleared = clearCredentials();
	if (cleared) {
		console.log('✅ Successfully logged out.');
		console.log(`   Removed credentials from ${getCredentialsPath()}\n`);
	} else {
		console.error('❌ Failed to clear credentials.\n');
		process.exit(1);
	}
}
