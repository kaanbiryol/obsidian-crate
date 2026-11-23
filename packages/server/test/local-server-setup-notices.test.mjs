import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceNotices } from '../src/commands/setup.mjs';

test('setup surfaces only the Funnel approval link and errors from the server log', () => {
	const log = [
		'Server address to paste into Obsidian: https://mac.tail1234.ts.net',
		'Data: /Users/me/.crate/server. Internal listener (diagnostics only): 127.0.0.1:8787',
		'Checking that the address is reachable. This can take a few minutes the first time.',
		'Funnel is not enabled on your tailnet.',
		'To enable, visit:',
		'',
		'         https://login.tailscale.com/f/funnel?node=abc123',
		'',
		'Error: Tailscale Funnel stopped (1).',
	].join('\n');
	assert.deepEqual(serviceNotices(log), [
		'Turn on Tailscale Funnel for your tailnet: https://login.tailscale.com/f/funnel?node=abc123',
		'Error: Tailscale Funnel stopped (1).',
	]);
});
