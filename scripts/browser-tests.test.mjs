import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { browserDurations, browserGroups, browserScripts, macosBrowserScripts, runBrowserTests, selectGroup, selectScripts } from './browser-tests.mjs';

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

test('every browser test script runs from the registry or a package script', () => {
	// Manual diagnostics documented in docs/ui-styling.md.
	const manual = new Set(['tests/browser/pwa/pwa-sync-indicator-test.mjs']);
	const packageScripts = Object.values(JSON.parse(readFileSync('package.json', 'utf8')).scripts).join('\n');
	const grouped = Object.values(browserGroups).flat();
	const scripts = readdirSync('tests/browser', { recursive: true })
		.filter(name => /-test\.mjs$/.test(name))
		.map(name => `tests/browser/${name}`);
	assert.ok(scripts.length > browserScripts.length);
	const unlisted = scripts.filter(script => !browserScripts.includes(script) && !grouped.includes(script)
		&& !packageScripts.includes(script) && !manual.has(script));
	assert.deepEqual(unlisted, []);
});

test('browser files outside support/ are -test.mjs entrypoints or -checks.mjs helpers', () => {
	const misnamed = readdirSync('tests/browser', { recursive: true })
		.filter(name => name.endsWith('.mjs') && !name.startsWith('support/') && !/[a-z0-9]-(?:test|checks)\.mjs$/.test(name.split('/').at(-1)));
	assert.deepEqual(misnamed, []);
});

test('plugin groups name existing scripts outside the PWA shards and reject unknown names', () => {
	const grouped = Object.values(browserGroups).flat();
	assert.equal(new Set(grouped).size, grouped.length);
	assert.ok(grouped.every(script => existsSync(script) && !browserScripts.includes(script)));
	assert.deepEqual(selectGroup('activity'), browserGroups.activity);
	assert.throws(() => selectGroup('toString'), /Unknown browser group/);
});

test('balances the four CI groups using measured durations', () => {
	assert.deepEqual(Object.keys(browserDurations).sort(), [...browserScripts].sort());
	assert.ok(Object.values(browserDurations).every(seconds => Number.isFinite(seconds) && seconds > 0));
	const totals = Array.from({ length: 4 }, (_, i) => selectScripts(`${i + 1}/4`)
		.reduce((total, script) => total + browserDurations[script], 0));
	const average = totals.reduce((a, b) => a + b) / 4;
	assert.ok(Math.max(...totals) < average * 1.1, `Expected each group within 10% of the ideal duration: ${totals}`);
});

test('Linux and native macOS groups retain every browser check exactly once', () => {
	assert.equal(new Set(macosBrowserScripts).size, macosBrowserScripts.length);
	assert.ok(macosBrowserScripts.every(script => browserScripts.includes(script)));
	const linux = Array.from({ length: 4 }, (_, i) => selectScripts(`${i + 1}/4`, 'linux')).flat();
	const macos = Array.from({ length: 2 }, (_, i) => selectScripts(`${i + 1}/2`, 'macos')).flat();
	assert.deepEqual([...linux, ...macos].sort(), [...browserScripts].sort());
	assert.deepEqual(macos.sort(), [...macosBrowserScripts].sort());
	for (const [platform, count] of [['linux', 4], ['macos', 2]]) {
		const totals = Array.from({ length: count }, (_, i) => selectScripts(`${i + 1}/${count}`, platform)
			.reduce((total, script) => total + browserDurations[script], 0));
		const average = totals.reduce((a, b) => a + b) / count;
		assert.ok(Math.max(...totals) < average * 1.1, `${platform} groups must remain balanced: ${totals}`);
	}
	assert.throws(() => selectScripts(undefined, 'unknown'), /Invalid browser platform/);
	assert.throws(() => selectScripts(`1/${macosBrowserScripts.length + 1}`, 'macos'), /Invalid shard/);
});

test('invalid shards fail instead of silently passing with no tests', () => {
	for (const shard of ['', '0/4', '5/4', '1/0', `1/${browserScripts.length + 1}`, '1.5/4', '1/4/2', '-1/4', '1/Infinity']) {
		assert.throws(() => selectScripts(shard), /Invalid shard/);
	}
});

const logger = { log() {}, error() {} };
test('builds once, preserves child environment and reports all test failures', () => {
	const calls = [];
	const results = [{ status: 0 }, { status: 0 }, { status: 1 }, { status: 0 }, { error: new Error('spawn failed') }, { status: 1 }];
	const status = runBrowserTests(['first', 'second', 'third'], {
		logger, env: { CI: 'true' },
		run(command, args, options) {
			calls.push({ command, args, options });
			return results.shift();
		},
	});
	assert.equal(status, 1);
	assert.deepEqual(calls.map(call => call.args[0]), ['scripts/build-worker.mjs', 'first', 'second', 'second', 'third', 'third']);
	assert.ok(calls.every(call => call.command === process.execPath));
	assert.ok(calls.every(call => call.options.env.CI === 'true'));
	assert.deepEqual(calls[0].options.env, { CI: 'true' });
	assert.ok(calls.slice(1).every(call => call.options.env.CRATE_PWA_PREBUILT === '1'));
});

test('plugin groups skip the Worker build', () => {
	const calls = [];
	assert.equal(runBrowserTests(['first'], { logger, buildWorker: false, run(command, args) { calls.push(args[0]); return { status: 0 }; } }), 0);
	assert.deepEqual(calls, ['first']);
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

test('retries a failed script once on CI only and reports a pass on retry as flaky', () => {
	const errors = [];
	let calls = 0;
	assert.equal(runBrowserTests(['first'], {
		logger: { log() {}, error: message => errors.push(String(message)) }, env: { CI: 'true' },
		run() { calls++; return calls === 2 ? { status: 1 } : { status: 0 }; },
	}), 0);
	assert.equal(calls, 3);
	assert.ok(errors.some(message => message.includes('Flaky: first')));
	calls = 0;
	assert.equal(runBrowserTests(['first'], { logger, env: {}, run() { return ++calls === 1 ? { status: 0 } : { status: 1 }; } }), 1);
	assert.equal(calls, 2);
});
