import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { browserDurations, browserScripts, runBrowserTests, selectScripts } from './pwa-browser-tests.mjs';

test('shards cover every existing browser script exactly once', () => {
	assert.equal(new Set(browserScripts).size, browserScripts.length);
	assert.ok(browserScripts.every(script => existsSync(script)));
	assert.deepEqual(selectScripts(), browserScripts);
	for (const total of [1, 2, 4, browserScripts.length]) {
		const shards = Array.from({ length: total }, (_, i) => selectScripts(`${i + 1}/${total}`));
		assert.deepEqual(shards.flat().sort(), [...browserScripts].sort());
		assert.ok(shards.every(shard => shard.length > 0));
	}
});

test('balances the four CI groups using measured durations', () => {
	assert.deepEqual(Object.keys(browserDurations).sort(), [...browserScripts].sort());
	assert.ok(Object.values(browserDurations).every(seconds => Number.isFinite(seconds) && seconds > 0));
	const totals = Array.from({ length: 4 }, (_, i) => selectScripts(`${i + 1}/4`)
		.reduce((total, script) => total + browserDurations[script], 0));
	const average = totals.reduce((a, b) => a + b) / 4;
	assert.ok(Math.max(...totals) < average * 1.1, `Expected each group within 10% of the ideal duration: ${totals}`);
});

test('invalid shards fail instead of silently passing with no tests', () => {
	for (const shard of ['', '0/4', '5/4', '1/0', `1/${browserScripts.length + 1}`, '1.5/4', '1/4/2', '-1/4', '1/Infinity']) {
		assert.throws(() => selectScripts(shard), /Invalid shard/);
	}
});

const logger = { log() {}, error() {} };
test('builds once, preserves child environment and reports all test failures', () => {
	const calls = [];
	const results = [{ status: 0 }, { status: 1 }, { error: new Error('spawn failed') }, { status: 0 }];
	const status = runBrowserTests(['first', 'second', 'third'], {
		logger, env: { CI: 'true' },
		run(command, args, options) {
			calls.push({ command, args, options });
			return results.shift();
		},
	});
	assert.equal(status, 1);
	assert.deepEqual(calls.map(call => call.args[0]), ['scripts/build-worker.mjs', 'first', 'second', 'third']);
	assert.ok(calls.every(call => call.command === process.execPath));
	assert.ok(calls.every(call => call.options.env.CI === 'true'));
	assert.deepEqual(calls[0].options.env, { CI: 'true' });
	assert.ok(calls.slice(1).every(call => call.options.env.CRATE_PWA_PREBUILT === '1'));
});

test('does not run any browser script after a failed or interrupted build', () => {
	for (const result of [{ status: 1 }, { error: new Error('spawn failed') }, { signal: 'SIGTERM', status: null }]) {
		let calls = 0;
		assert.equal(runBrowserTests(['first'], { logger, run() { calls++; return result; } }), 1);
		assert.equal(calls, 1);
	}
});

test('stops after a child is terminated and succeeds only if all children pass', () => {
	let calls = 0;
	assert.equal(runBrowserTests(['first', 'second'], {
		logger, run() { return ++calls === 1 ? { status: 0 } : { signal: 'SIGTERM', status: null }; },
	}), 1);
	assert.equal(calls, 2);
	assert.equal(runBrowserTests(['first', 'second'], { logger, run: () => ({ status: 0 }) }), 0);
});
