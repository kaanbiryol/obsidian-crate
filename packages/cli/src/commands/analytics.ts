/**
 * `crate analytics` command - Prints instructions for setting up analytics
 */

export async function analyticsCommand(): Promise<void> {
	console.log('\n📊 Crate - Analytics Setup\n');
	console.log('To enable usage analytics in the Obsidian plugin:\n');
	console.log('1. Go to https://dash.cloudflare.com/profile/api-tokens');
	console.log('2. Create a token with: Account > Account Analytics > Read');
	console.log('3. Paste the token into Crate settings > Analytics Token\n');
}
