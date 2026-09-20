import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairing } from './local-server-pairing.mjs';
import { monitorPublicReadiness } from './local-server-readiness.mjs';

test('pairing codes expire, are claimed once under concurrent requests, and store only token hashes', async () => {
	let time = 100;
	const registered = [];
	const db = { prepare: () => ({ bind: (...args) => ({ async run() { await delay(5); registered.push(args); } }) }) };
	const pairing = createPairing({ db, now: () => time, lifetime: 10 });
	const first = pairing.issue('Phone');
	assert.equal(await pairing.exchange('invalid'), null);
	const results = await Promise.all([pairing.exchange(first.code), pairing.exchange(first.code)]);
	assert.equal(results.filter(Boolean).length, 1);
	assert.equal(registered.length, 1);
	assert.notEqual(registered[0][1], results.find(Boolean).token);
	const expired = pairing.issue();
	time += 10;
	assert.equal(await pairing.exchange(expired.code), null);
	assert.equal(registered.length, 1);
	assert.throws(() => pairing.issue(''), /device name/);
});

test('public readiness waits for this instance and retries DNS errors without announcing premature success', async () => {
	const changes = [];
	let attempts = 0;
	let markReady;
	const ready = new Promise(resolve => { markReady = resolve; });
	const monitor = monitorPublicReadiness({ origin: 'https://test.example', instance: 'expected', interval: 1,
		fetchPublic: async (_url, options) => {
			assert.equal(options.redirect, 'error');
			if (++attempts === 1) throw new Error('ENOTFOUND');
			return Response.json({ instance: attempts === 2 ? 'old-server' : 'expected' });
		},
		onChange: value => { changes.push(value); if (value) markReady(); },
	});
	try { await ready; assert.deepEqual(changes, [false, true]); assert.equal(attempts, 3); }
	finally { await monitor.close(); }
});
