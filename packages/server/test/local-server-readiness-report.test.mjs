import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readinessReport } from '../src/commands/start.mjs';

/** @param {() => Promise<void> | void} run */
async function captured(run) {
	const lines = [];
	const original = console.log;
	console.log = (/** @type {string} */ line) => { lines.push(line); };
	try { await run(); } finally { console.log = original; }
	return lines;
}

test('holds the first connection code until the public address works', async () => {
	let issued = 0;
	const report = readinessReport(false);
	const lines = await captured(() => {
		report.changed(false);
		assert.equal(report.pair(() => `\ncode-${++issued}`), '');
		assert.equal(report.waiting, true);
		report.changed(true);
		report.changed(false);
		report.changed(true);
	});
	assert.equal(issued, 1, 'The code is issued once, when it is shown');
	assert.ok(lines[1].endsWith('\ncode-1'), 'The code prints in the same write as the ready line');
	assert.equal(report.waiting, false);
	assert.deepEqual(lines.map(line => line.split('\n')[0]), [
		'Checking that the address is reachable. This can take a few minutes the first time.',
		'Ready: the public HTTPS address reaches this Crate server.',
		'Checking that the address is reachable. This can take a few minutes the first time.',
		'Ready: the public HTTPS address reaches this Crate server.',
	]);
});

test('shows the code at once when there is no public address to wait for', () => {
	const report = readinessReport(true);
	assert.equal(report.pair(() => 'code'), 'code');
	assert.equal(report.waiting, false);
});
