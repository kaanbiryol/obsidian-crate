import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listenLocalServer } from '../src/local-server-http.mjs';
import { createPairing, startLocalControl } from '../src/local-server-pairing.mjs';
import { issueLocalDevice, openLocalRuntime } from '../src/local-server-runtime.mjs';

test('devices read the host status through their own authorization, and host alerts reach the dispatcher', { timeout: 60_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-host-status-test-'));
	const runtime = await openLocalRuntime({ dataDir, handleSignals: false });
	const server = await listenLocalServer(runtime, { port: 0 });
	const control = await startLocalControl({ dataDir, pairing: createPairing({ db: runtime.db }), origin: 'https://crate.example.ts.net', runtime });
	try {
		const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
		const { token } = /** @type {{ token: string }} */ (await issueLocalDevice(runtime.db, 'Mac'));
		const info = await (await fetch(`${origin}/.well-known/crate`)).json();
		const read = async (/** @type {string | undefined} */ bearer) => fetch(`${origin}/server/host-status`, { headers: {
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'X-Crate-Protocol': String(info.protocol.current) } });
		assert.equal((await read(undefined)).status, 401);
		control.onReadiness(true);
		let host;
		for (let attempt = 0; attempt < 50 && host?.publicAccess !== 'ready'; attempt++) {
			host = (await (await read(token)).json()).host;
			if (host?.publicAccess !== 'ready') await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.equal(host.install, 'source');
		assert.equal(host.publicAccess, 'ready');
		assert.equal(host.lastBackupAt, null);
		assert.deepEqual(host.autoBackup, { on: false, lastFailureAt: null });
		assert.ok(Number.isSafeInteger(host.diskFreeBytes) && host.diskFreeBytes > 0);
		assert.ok(!JSON.stringify(host).includes(dataDir));
		// No browser has enrolled for push, so the dispatcher accepts and sends to none.
		assert.equal(await runtime.alert('backup-failed'), 0);
		await assert.rejects(runtime.alert('anything-else'), /400/);
	} finally {
		await control.close();
		await new Promise(resolve => server.close(resolve));
		await runtime.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});
