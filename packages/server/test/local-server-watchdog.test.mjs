import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchRuntime } from '../src/local-server-watchdog.mjs';

test('the runtime watchdog fails only after consecutive missed probes', async () => {
	const outcomes = [false, false, true, false, false, false];
	let probes = 0;
	const watchdog = watchRuntime({ interval: 1, limit: 3, async probe() {
		if (!outcomes[probes++]) throw new Error('runtime unavailable');
	} });
	await assert.rejects(watchdog.failed, /stopped responding \(runtime unavailable\)/);
	assert.equal(probes, 6);
});

test('the runtime watchdog counts a hung probe as missed', async () => {
	const watchdog = watchRuntime({ interval: 1, timeout: 5, limit: 1, probe: signal => new Promise((_, reject) => {
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	}) });
	await assert.rejects(watchdog.failed, /stopped responding/);
});

test('a closed runtime watchdog stops probing and never fails', async () => {
	let probes = 0;
	const watchdog = watchRuntime({ interval: 1, limit: 1, async probe() { probes++; } });
	while (probes < 2) await new Promise(resolve => setTimeout(resolve, 1));
	watchdog.close();
	const settled = await Promise.race([watchdog.failed.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 50))]);
	assert.equal(settled, 'pending');
	const after = probes;
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(probes, after);
});
