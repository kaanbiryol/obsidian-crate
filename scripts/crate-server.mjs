#!/usr/bin/env node
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major !== 26 || minor < 8 || (minor === 8 && patch < 2)) {
	console.error('Crate server requires Node.js 26.8.2 or newer in the 26.x series. Install Node 26, then run this command again.');
	process.exitCode = 1;
} else {
	const args = process.argv.slice(2);
	if (!args.length || (args[0].startsWith('--') && !args.includes('--help'))) args.unshift('setup');
	process.argv = [...process.argv.slice(0, 2), ...args];
	await import('./local-server.mjs');
}
