import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createAlerts, LOW_DISK_BYTES } from '../src/local-server-alerts.mjs';

async function withAlerts(/** @type {(context: { alerts: ReturnType<typeof createAlerts>, sent: string[], clock: { now: number } }) => Promise<void>} */ run, lossDelay = 20) {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-alerts-'));
	/** @type {string[]} */
	const sent = [];
	const clock = { now: Date.parse('2026-11-21T10:00:00Z') };
	const alerts = createAlerts({ dataDir, send: async kind => { sent.push(kind); return 1; }, now: () => clock.now, lossDelay });
	try { await run({ alerts, sent, clock }); }
	finally { await alerts.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test('sends each kind at most once a day, remembered across restarts', async () => {
	await withAlerts(async ({ alerts, sent, clock }) => {
		await alerts.notify('backup-failed');
		await alerts.notify('backup-failed');
		await alerts.notify('low-disk');
		clock.now += 23 * 60 * 60_000;
		await alerts.notify('backup-failed');
		clock.now += 2 * 60 * 60_000;
		await alerts.notify('backup-failed');
		assert.deepEqual(sent, ['backup-failed', 'low-disk', 'backup-failed']);
	});
});

test('alerts only when public access stays lost, and on a nearly full disk', async () => {
	await withAlerts(async ({ alerts, sent }) => {
		alerts.publicAccess(false);
		alerts.publicAccess(true);
		await delay(40);
		assert.deepEqual(sent, []);
		alerts.publicAccess(false);
		await delay(40);
		alerts.disk(LOW_DISK_BYTES * 2);
		alerts.disk(null);
		await alerts.notify('low-disk').then(() => {});
		assert.deepEqual(sent, ['public-access-lost', 'low-disk']);
	});
});

test('a failed send is retried next time instead of being recorded', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-alerts-'));
	let attempts = 0;
	const alerts = createAlerts({ dataDir, send: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return 0; } });
	try {
		await alerts.notify('low-disk');
		await alerts.notify('low-disk');
		await alerts.notify('low-disk');
		assert.equal(attempts, 2);
	} finally { await alerts.close(); await rm(dataDir, { recursive: true, force: true }); }
});
